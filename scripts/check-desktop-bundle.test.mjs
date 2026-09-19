// Focused tests for the desktop bundle guard. Every case builds a throwaway
// bundle that mirrors the shape Vite emits for Tauri, then breaks exactly one
// property so each failure is deterministic and its message is asserted.
//
//   node --test scripts/check-desktop-bundle.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BundleCheckError,
  assetReferencesIn,
  checkDesktopBundle,
  checkShellStylesheet,
  defaultTauriConfigPath,
  parseArguments,
  readTauriConfig,
  resolveFrontendDist,
  topLevelRules,
} from './check-desktop-bundle.mjs';

const scriptPath = fileURLToPath(new URL('./check-desktop-bundle.mjs', import.meta.url));
const repositoryRoot = resolve(dirname(scriptPath), '..');

// The layout rules as lightningcss emits them: declarations reordered, plus a
// narrow-width media override that must not satisfy the base-layout check.
const shellCss = [
  '[hidden]{display:none!important}',
  '.app-shell{background:var(--bg);flex-direction:column;width:100vw;height:100vh;display:flex}',
  '.app-body{flex:1;min-height:0;display:flex}',
  '.sidebar{flex:0 0 var(--sidebar-width);border-right:1px solid var(--border);flex-direction:column;min-width:0;display:flex}',
  '.workspace{background:var(--bg);flex:1;min-height:0;padding:8px 10px;display:flex}',
  '@media (width<=820px){.sidebar{flex-basis:58px}.workspace{flex-direction:column;overflow:auto}}',
].join('');

const shellCsp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; font-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'";

function indexHtml({ script = './assets/index-XBzTUylL.js', stylesheet = './assets/index-C7cWOVZN.css', head = '' } = {}) {
  const scriptTag = script === null ? '' : `<script type="module" crossorigin src="${script}"></script>`;
  const stylesheetTag = stylesheet === null ? '' : `<link rel="stylesheet" crossorigin href="${stylesheet}">`;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">${head}${scriptTag}${stylesheetTag}</head><body><div class="app-shell"></div></body></html>`;
}

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

// Writes <root>/dist with the given files and <root>/src-tauri/tauri.conf.json
// whose frontendDist points back at it, so the checker sees a real layout.
function writeBundle({ index = indexHtml(), css = shellCss, js = 'console.log("shell")', csp = shellCsp, frontendDist = '../dist', files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'devtools-bundle-check-'));
  temporaryRoots.push(root);
  const distDirectory = join(root, 'dist');
  const assets = join(distDirectory, 'assets');
  mkdirSync(assets, { recursive: true });
  if (index !== null) writeFileSync(join(distDirectory, 'index.html'), index);
  if (css !== null) writeFileSync(join(assets, 'index-C7cWOVZN.css'), css);
  if (js !== null) writeFileSync(join(assets, 'index-XBzTUylL.js'), js);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const tauriConfigPath = join(root, 'src-tauri', 'tauri.conf.json');
  mkdirSync(dirname(tauriConfigPath), { recursive: true });
  writeFileSync(tauriConfigPath, JSON.stringify({ build: { frontendDist }, app: { security: { csp } } }));
  return { root, distDirectory, tauriConfigPath };
}

function expectFailure(bundle, pattern) {
  assert.throws(() => checkDesktopBundle({ tauriConfigPath: bundle.tauriConfigPath }), (error) => {
    assert.ok(error instanceof BundleCheckError, `expected BundleCheckError, got ${error?.constructor?.name}: ${error?.message}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe('accepted bundles', () => {
  test('accepts a bundle shaped like the Vite output for Tauri', () => {
    const bundle = writeBundle();
    const report = checkDesktopBundle({ tauriConfigPath: bundle.tauriConfigPath });
    assert.equal(report.distDirectory, bundle.distDirectory);
    assert.deepEqual(report.scripts, ['index-XBzTUylL.js']);
    assert.deepEqual(report.stylesheets, ['index-C7cWOVZN.css']);
    assert.deepEqual(report.selectors, ['[hidden]', '.app-shell', '.app-body', '.sidebar', '.workspace']);
  });

  test('accepts bare relative paths and ignores query strings and fragments', () => {
    const bundle = writeBundle({ index: indexHtml({ script: 'assets/index-XBzTUylL.js?v=3', stylesheet: 'assets/index-C7cWOVZN.css#shell' }) });
    assert.doesNotThrow(() => checkDesktopBundle({ tauriConfigPath: bundle.tauriConfigPath }));
  });

  test('accepts a relative <base href> and modulepreload links to existing chunks', () => {
    const bundle = writeBundle({
      index: indexHtml({ head: '<base href="./"><link rel="modulepreload" crossorigin href="./assets/vendor-abc123.js">' }),
      files: { 'dist/assets/vendor-abc123.js': 'export {}' },
    });
    const report = checkDesktopBundle({ tauriConfigPath: bundle.tauriConfigPath });
    assert.deepEqual(report.scripts, ['vendor-abc123.js', 'index-XBzTUylL.js']);
  });

  test('the --dist override checks that directory with the given Tauri config', () => {
    const bundle = writeBundle();
    const elsewhere = writeBundle({ index: indexHtml({ script: '/assets/index-XBzTUylL.js' }) });
    const options = parseArguments(['--dist', bundle.distDirectory, '--tauri-config', elsewhere.tauriConfigPath]);
    assert.equal(options.distDirectory, bundle.distDirectory);
    assert.equal(options.tauriConfigPath, elsewhere.tauriConfigPath);
    assert.doesNotThrow(() => checkDesktopBundle(options));
  });
});

describe('asset URL failures', () => {
  test('rejects an absolute asset URL even when the file exists', () => {
    const bundle = writeBundle({ index: indexHtml({ script: '/assets/index-XBzTUylL.js' }) });
    expectFailure(bundle, /asset URL must be relative .*: \/assets\/index-XBzTUylL\.js/);
  });

  test('rejects a scheme URL for the stylesheet', () => {
    const bundle = writeBundle({ index: indexHtml({ stylesheet: 'https://cdn.example.com/index.css' }) });
    expectFailure(bundle, /asset URL must be relative .*: https:\/\/cdn\.example\.com\/index\.css/);
  });

  test('rejects a protocol-relative asset URL', () => {
    const bundle = writeBundle({ index: indexHtml({ script: '//cdn.example.com/index.js' }) });
    expectFailure(bundle, /asset URL must be relative .*: \/\/cdn\.example\.com\/index\.js/);
  });

  test('rejects an asset URL that escapes the bundle directory even when the file exists', () => {
    const bundle = writeBundle({ index: indexHtml({ script: '../outside.js' }), files: { 'outside.js': 'export {}' } });
    expectFailure(bundle, /resolves outside the bundle directory: \.\.\/outside\.js/);
  });

  test('rejects an absolute <base href>', () => {
    const bundle = writeBundle({ index: indexHtml({ head: '<base href="/">' }) });
    expectFailure(bundle, /<base href> must stay relative/);
  });
});

describe('missing asset failures', () => {
  test('rejects a referenced script that was not emitted', () => {
    const bundle = writeBundle({ js: null });
    expectFailure(bundle, /missing asset: \.\/assets\/index-XBzTUylL\.js/);
  });

  test('rejects a stylesheet whose hash no longer matches the emitted file', () => {
    const bundle = writeBundle({ index: indexHtml({ stylesheet: './assets/index-OLDHASH0.css' }) });
    expectFailure(bundle, /missing asset: \.\/assets\/index-OLDHASH0\.css/);
  });

  test('rejects an asset reference that only matches case-insensitively', () => {
    const bundle = writeBundle({ index: indexHtml({ script: './assets/INDEX-xbztuyll.js' }) });
    // Case-insensitive filesystems find the file and must still fail on case;
    // case-sensitive ones report it as missing. Both keep the app from loading.
    expectFailure(bundle, /(case does not match the file on disk \(.*\)|missing asset): \.\/assets\/INDEX-xbztuyll\.js/);
  });

  test('rejects an asset reference that points at a directory', () => {
    const bundle = writeBundle({ index: indexHtml({ script: './assets' }) });
    expectFailure(bundle, /missing asset: \.\/assets$/);
  });

  test('rejects an index that loads no script or links no stylesheet', () => {
    expectFailure(writeBundle({ index: indexHtml({ script: null }) }), /does not load any JavaScript/);
    expectFailure(writeBundle({ index: indexHtml({ stylesheet: null }) }), /does not link any stylesheet/);
  });

  test('a modulepreload link does not stand in for the entry script', () => {
    const bundle = writeBundle({ index: indexHtml({ script: null, head: '<link rel="modulepreload" href="./assets/index-XBzTUylL.js">' }) });
    expectFailure(bundle, /does not load any JavaScript/);
  });

  test('rejects a missing index and names the build command', () => {
    const bundle = writeBundle({ index: null });
    expectFailure(bundle, /missing build output .*index\.html; run pnpm --dir apps\/desktop build first/);
  });
});

describe('shell stylesheet failures', () => {
  test('rejects a layout declaration that only survives inside a media query', () => {
    const css = shellCss.replace('.app-body{flex:1;min-height:0;display:flex}', '.app-body{flex:1;min-height:0}@media (width>=1px){.app-body{display:flex}}');
    expectFailure(writeBundle({ css }), /\.app-body must include display: flex .*\(found: nothing\)/);
  });

  test('rejects a required selector with no top-level rule', () => {
    const css = shellCss.replace('.workspace{background:var(--bg);flex:1;min-height:0;padding:8px 10px;display:flex}', '');
    expectFailure(writeBundle({ css }), /\.workspace has no top-level rule/);
  });

  test('rejects a required declaration with the wrong value', () => {
    const css = shellCss.replace('.app-shell{background:var(--bg);flex-direction:column;', '.app-shell{background:var(--bg);flex-direction:row;');
    expectFailure(writeBundle({ css }), /\.app-shell must include flex-direction: column .*\(found: row\)/);
  });

  test('rejects [hidden] without !important', () => {
    const css = shellCss.replace('[hidden]{display:none!important}', '[hidden]{display:none}');
    expectFailure(writeBundle({ css }), /\[hidden\] must include display: none !important/);
  });

  test('checks the stylesheets the index links, not stray files in the bundle', () => {
    const bundle = writeBundle({ css: '.unrelated{color:red}', files: { 'dist/assets/stale-shell.css': shellCss } });
    expectFailure(bundle, /\[hidden\] must include/);
  });

  test('a later top-level rule may refine but not remove an earlier declaration', () => {
    assert.doesNotThrow(() => checkShellStylesheet(`${shellCss}.app-body{min-height:1px}`));
    assert.throws(() => checkShellStylesheet(`${shellCss}.app-body{display:block}`), /\.app-body must include display: flex .*\(found: block\)/);
  });
});

describe('Tauri configuration failures', () => {
  test('rejects a CSP whose style-src blocks the bundled stylesheet', () => {
    const bundle = writeBundle({ csp: "default-src 'self'; style-src 'none'" });
    expectFailure(bundle, /CSP style-src must allow 'self' .*\(found: 'none'\)/);
  });

  test('falls back to default-src when script-src is absent', () => {
    expectFailure(writeBundle({ csp: "default-src 'none'; style-src 'self'" }), /CSP script-src must allow 'self'/);
    assert.doesNotThrow(() => checkDesktopBundle({ tauriConfigPath: writeBundle({ csp: "default-src 'self'" }).tauriConfigPath }));
  });

  test('accepts the object form of the CSP', () => {
    const bundle = writeBundle({ csp: { 'default-src': "'self'", 'style-src': ["'self'", "'unsafe-inline'"] } });
    assert.doesNotThrow(() => checkDesktopBundle({ tauriConfigPath: bundle.tauriConfigPath }));
  });

  test('rejects a removed CSP', () => {
    expectFailure(writeBundle({ csp: null }), /app\.security\.csp must be a policy/);
  });

  test('rejects a frontendDist that is a URL or does not exist', () => {
    expectFailure(writeBundle({ frontendDist: 'http://127.0.0.1:1420' }), /frontendDist must be a local directory, not a URL/);
    expectFailure(writeBundle({ frontendDist: '../build' }), /missing build output/);
    expectFailure(writeBundle({ frontendDist: '' }), /frontendDist must name the bundle directory/);
  });

  test('rejects a missing or malformed Tauri config', () => {
    const bundle = writeBundle();
    writeFileSync(bundle.tauriConfigPath, '{ not json');
    expectFailure(bundle, /Tauri config is not valid JSON/);
    assert.throws(() => checkDesktopBundle({ tauriConfigPath: join(bundle.root, 'nope.json') }), /missing Tauri config/);
  });
});

describe('parsers', () => {
  test('assetReferencesIn only reads script src, link href and base href', () => {
    const html = '<a href="/docs.css">x</a><img src="/logo.js"><script type="module" crossorigin src="./a.js"></script><link rel="stylesheet" href=\'./b.css\'><link rel="icon" href="./icon.png"><base href="./">';
    assert.deepEqual(assetReferencesIn(html), [
      { tag: 'script', kind: 'script', url: './a.js' },
      { tag: 'link', kind: 'stylesheet', url: './b.css' },
      { tag: 'link', kind: 'link', url: './icon.png' },
      { tag: 'base', kind: 'base', url: './' },
    ]);
  });

  test('assetReferencesIn ignores references inside HTML comments', () => {
    const html = '<!-- <script src="/legacy/old.js"></script> --><script type="module" src="./a.js"></script><!--\n<link rel="stylesheet" href="/old.css">\n-->';
    assert.deepEqual(assetReferencesIn(html), [{ tag: 'script', kind: 'script', url: './a.js' }]);
  });

  test('topLevelRules skips at-rules, comments and braces inside strings', () => {
    const css = '@charset "utf-8";@import url("x.css");/* {comment} */.a,.b{content:"{";color:red}@media (x){.a{color:blue}}@font-face{font-family:"F"}.c{display:flex}';
    assert.deepEqual(topLevelRules(css), [
      { selectors: ['.a', '.b'], declarations: [['content', '"{"'], ['color', 'red']] },
      { selectors: ['.c'], declarations: [['display', 'flex']] },
    ]);
  });

  test('parseArguments rejects unknown flags and missing values', () => {
    assert.throws(() => parseArguments(['--verbose']), /unknown argument: --verbose/);
    assert.throws(() => parseArguments(['--dist']), /--dist requires a path/);
  });
});

describe('command line', () => {
  function runScript(args) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  }

  test('exits 0 with a summary for a valid bundle', () => {
    const bundle = writeBundle();
    const result = runScript(['--tauri-config', bundle.tauriConfigPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^desktop bundle check passed: .* \(1 script, 1 stylesheet assets; 5 shell selectors verified\)\n$/);
    assert.equal(result.stderr, '');
  });

  test('exits 1 and reports the missing asset on stderr', () => {
    const bundle = writeBundle({ js: null });
    const result = runScript(['--tauri-config', bundle.tauriConfigPath]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^desktop bundle check failed: generated index references a missing asset: \.\/assets\/index-XBzTUylL\.js\n$/);
  });

  test('exits 1 for an absolute asset URL', () => {
    const bundle = writeBundle({ index: indexHtml({ stylesheet: '/assets/index-C7cWOVZN.css' }) });
    const result = runScript(['--tauri-config', bundle.tauriConfigPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /asset URL must be relative .*: \/assets\/index-C7cWOVZN\.css/);
  });
});

describe('checked-in configuration', () => {
  test('tauri.conf.json embeds apps/desktop/dist and keeps a CSP that allows bundled assets', () => {
    const config = readTauriConfig(defaultTauriConfigPath);
    assert.equal(resolveFrontendDist(config, defaultTauriConfigPath), join(repositoryRoot, 'apps', 'desktop', 'dist'));
    assert.match(config.app.security.csp, /(^|; )script-src 'self'(;|$)/);
    assert.match(config.app.security.csp, /(^|; )style-src 'self'/);
  });

  test('the real build output passes', { skip: !existsSync(join(repositoryRoot, 'apps', 'desktop', 'dist', 'index.html')) && 'run pnpm --dir apps/desktop build first' }, () => {
    const report = checkDesktopBundle();
    assert.equal(report.scripts.length, 1);
    assert.equal(report.stylesheets.length, 1);
  });
});
