#!/usr/bin/env node

// Guards the packaged desktop bundle against the failure the native window
// cannot report on its own: an index.html whose stylesheet or script never
// loads, so the Tauri webview shows an unstyled fallback document. It checks
// the directory Tauri embeds (build.frontendDist), the asset URLs in the
// generated index, the files they resolve to, the CSP those assets must pass,
// and the top-level shell layout rules in the emitted stylesheet.
//
//   node scripts/check-desktop-bundle.mjs [--dist <dir>] [--tauri-config <file>]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const defaultTauriConfigPath = join(repositoryRoot, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');

// Top-level rules the shell needs before any tool renders. Losing one of these
// turns the native window into a stacked, scrolling document.
export const requiredLayout = [
  ['.app-shell', [['display', 'flex'], ['flex-direction', 'column']]],
  ['.app-body', [['display', 'flex'], ['flex', '1']]],
  ['.sidebar', [['display', 'flex'], ['flex-direction', 'column']]],
  ['.workspace', [['display', 'flex'], ['flex', '1']]],
];

export class BundleCheckError extends Error {}

function fail(message) {
  throw new BundleCheckError(message);
}

function hasScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

// --- Tauri configuration -------------------------------------------------

export function readTauriConfig(tauriConfigPath) {
  if (!existsSync(tauriConfigPath)) {
    fail(`missing Tauri config at ${tauriConfigPath}`);
  }
  try {
    return JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
  } catch (error) {
    return fail(`Tauri config is not valid JSON: ${error.message}`);
  }
}

export function resolveFrontendDist(config, tauriConfigPath) {
  const frontendDist = config?.build?.frontendDist;
  if (typeof frontendDist !== 'string' || frontendDist === '') {
    fail('tauri.conf.json build.frontendDist must name the bundle directory so the packaged assets can be checked');
  }
  if (!isAbsolute(frontendDist) && hasScheme(frontendDist)) {
    fail(`build.frontendDist must be a local directory, not a URL: ${frontendDist}`);
  }
  return resolve(dirname(tauriConfigPath), frontendDist);
}

function parseContentSecurityPolicy(csp) {
  const directives = new Map();
  if (typeof csp === 'string') {
    for (const part of csp.split(';')) {
      const [name, ...sources] = part.trim().split(/\s+/);
      if (name) directives.set(name.toLowerCase(), sources);
    }
  } else if (csp && typeof csp === 'object') {
    for (const [name, value] of Object.entries(csp)) {
      const sources = Array.isArray(value) ? value : String(value).split(/\s+/);
      directives.set(name.toLowerCase(), sources.filter(Boolean));
    }
  } else {
    fail('tauri.conf.json app.security.csp must be a policy; a missing policy silently disables the CSP the bundle is checked against');
  }
  return directives;
}

// Bundled scripts and stylesheets load from the app's own origin, so the
// effective script-src and style-src must allow 'self' or the page renders
// without them and no build step reports it.
export function checkContentSecurityPolicy(config) {
  const directives = parseContentSecurityPolicy(config?.app?.security?.csp);
  for (const [directive, kind] of [['script-src', 'scripts'], ['style-src', 'stylesheets']]) {
    const sources = directives.get(directive) ?? directives.get('default-src');
    if (sources === undefined) continue;
    if (!sources.some((source) => source.toLowerCase() === "'self'")) {
      fail(`CSP ${directive} must allow 'self' so bundled ${kind} load (found: ${sources.join(' ') || 'nothing'})`);
    }
  }
}

// --- Generated index -----------------------------------------------------

function attributesOf(text) {
  const attributes = new Map();
  for (const match of text.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

export function assetReferencesIn(html) {
  const references = [];
  for (const match of html.matchAll(/<(script|link|base)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    const attributes = attributesOf(match[2]);
    if (tag === 'script' && attributes.has('src')) {
      references.push({ tag, kind: 'script', url: attributes.get('src') });
    } else if (tag === 'link' && attributes.has('href')) {
      const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
      const kind = rel.includes('stylesheet') ? 'stylesheet' : rel.includes('modulepreload') ? 'modulepreload' : 'link';
      references.push({ tag, kind, url: attributes.get('href') });
    } else if (tag === 'base' && attributes.has('href')) {
      references.push({ tag, kind: 'base', url: attributes.get('href') });
    }
  }
  return references;
}

// Tauri's embedded asset table is keyed by the exact path, so a reference that
// only matches on a case-insensitive filesystem still fails inside the app.
function existsWithExactCase(distDirectory, assetPath) {
  let current = distDirectory;
  for (const segment of relative(distDirectory, assetPath).split(/[\\/]/)) {
    if (!readdirSync(current).includes(segment)) return false;
    current = join(current, segment);
  }
  return true;
}

function resolveAsset(distDirectory, reference) {
  const { url } = reference;
  const path = url.split(/[?#]/)[0];
  if (path === '') {
    fail(`generated index has an empty ${reference.tag} URL`);
  }
  if (path.startsWith('/') || hasScheme(path)) {
    fail(`asset URL must be relative so the Tauri protocol can resolve it: ${url}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    fail(`asset URL is not decodable: ${url}`);
  }
  const assetPath = resolve(distDirectory, decoded);
  const inside = relative(distDirectory, assetPath);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    fail(`asset URL resolves outside the bundle directory: ${url}`);
  }
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    fail(`generated index references a missing asset: ${url}`);
  }
  if (!existsWithExactCase(distDirectory, assetPath)) {
    fail(`asset path case does not match the file on disk (Tauri asset lookup is case-sensitive): ${url}`);
  }
  return assetPath;
}

// --- Built stylesheet ----------------------------------------------------

function splitOutsideStrings(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function normalizeValue(value) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseDeclarations(body) {
  const declarations = [];
  for (const declaration of splitOutsideStrings(body, ';')) {
    const separator = declaration.indexOf(':');
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (property) declarations.push([property, normalizeValue(declaration.slice(separator + 1))]);
  }
  return declarations;
}

// Returns the style rules that sit outside every at-rule, in source order.
// Rules nested in @media blocks are deliberately excluded: they override the
// shell only at some widths and must not satisfy a check for the base layout.
export function topLevelRules(css) {
  const rules = [];
  let depth = 0;
  let quote = null;
  let preludeStart = 0;
  let bodyStart = -1;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      index = end === -1 ? css.length : end + 1;
    } else if (character === '{') {
      if (depth === 0) bodyStart = index + 1;
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && bodyStart !== -1) {
        const prelude = css.slice(preludeStart, bodyStart - 1).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (!prelude.startsWith('@')) {
          rules.push({
            selectors: splitOutsideStrings(prelude, ',').map((selector) => selector.trim()).filter(Boolean),
            declarations: parseDeclarations(css.slice(bodyStart, index)),
          });
        }
        preludeStart = index + 1;
        bodyStart = -1;
      }
    } else if (character === ';' && depth === 0) {
      preludeStart = index + 1;
    }
  }
  return rules;
}

// Merges every top-level rule for exactly this selector in cascade order, so
// a later rule may refine an earlier one but neither may be missing.
export function topLevelDeclarationsFor(css, selector) {
  const merged = new Map();
  let ruleCount = 0;
  for (const rule of topLevelRules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    ruleCount += 1;
    for (const [property, value] of rule.declarations) merged.set(property, value);
  }
  return ruleCount === 0 ? null : merged;
}

export function checkShellStylesheet(css) {
  const hidden = topLevelDeclarationsFor(css, '[hidden]');
  if (hidden === null || !/^none\s*!important$/.test(hidden.get('display') ?? '')) {
    fail('[hidden] must include display: none !important in the built stylesheet');
  }
  for (const [selector, expectedDeclarations] of requiredLayout) {
    const declarations = topLevelDeclarationsFor(css, selector);
    if (declarations === null) {
      fail(`${selector} has no top-level rule in the built stylesheet`);
    }
    for (const [property, expectedValue] of expectedDeclarations) {
      const actual = declarations.get(property);
      if (actual !== normalizeValue(expectedValue)) {
        fail(`${selector} must include ${property}: ${expectedValue} in the built stylesheet (found: ${actual ?? 'nothing'})`);
      }
    }
  }
}

// --- Entry ---------------------------------------------------------------

export function checkDesktopBundle({ tauriConfigPath = defaultTauriConfigPath, distDirectory } = {}) {
  const config = readTauriConfig(tauriConfigPath);
  const dist = distDirectory ?? resolveFrontendDist(config, tauriConfigPath);
  checkContentSecurityPolicy(config);

  const indexPath = join(dist, 'index.html');
  if (!existsSync(indexPath)) {
    fail(`missing build output at ${relative(repositoryRoot, indexPath) || indexPath}; run pnpm --dir apps/desktop build first`);
  }

  const references = assetReferencesIn(readFileSync(indexPath, 'utf8'));
  const scripts = [];
  const stylesheets = [];
  for (const reference of references) {
    if (reference.kind === 'base') {
      if (reference.url.startsWith('/') || hasScheme(reference.url)) {
        fail(`<base href> must stay relative so bundled assets resolve under the Tauri protocol: ${reference.url}`);
      }
      continue;
    }
    const assetPath = resolveAsset(dist, reference);
    if (reference.kind === 'script' || reference.kind === 'modulepreload') scripts.push(assetPath);
    if (reference.kind === 'stylesheet') stylesheets.push(assetPath);
  }
  if (!references.some((reference) => reference.kind === 'script')) {
    fail('generated index does not load any JavaScript');
  }
  if (stylesheets.length === 0) {
    fail('generated index does not link any stylesheet');
  }

  checkShellStylesheet(stylesheets.map((path) => readFileSync(path, 'utf8')).join('\n'));

  return {
    distDirectory: dist,
    scripts: scripts.map((path) => basename(path)),
    stylesheets: stylesheets.map((path) => basename(path)),
    selectors: ['[hidden]', ...requiredLayout.map(([selector]) => selector)],
  };
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dist' || argument === '--tauri-config') {
      const value = argv[index + 1];
      if (value === undefined) fail(`${argument} requires a path`);
      options[argument === '--dist' ? 'distDirectory' : 'tauriConfigPath'] = resolve(value);
      index += 1;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (isMainModule()) {
  try {
    const report = checkDesktopBundle(parseArguments(process.argv.slice(2)));
    const inRepository = relative(repositoryRoot, report.distDirectory);
    const location = inRepository && !inRepository.startsWith('..') && !isAbsolute(inRepository) ? inRepository : report.distDirectory;
    process.stdout.write(
      `desktop bundle check passed: ${location} (${report.scripts.length} script, ${report.stylesheets.length} stylesheet assets; ${report.selectors.length} shell selectors verified)\n`,
    );
  } catch (error) {
    if (!(error instanceof BundleCheckError)) throw error;
    process.stderr.write(`desktop bundle check failed: ${error.message}\n`);
    process.exit(1);
  }
}
