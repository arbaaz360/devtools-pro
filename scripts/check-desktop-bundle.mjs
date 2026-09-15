#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const distDirectory = join(repositoryRoot, 'apps', 'desktop', 'dist');
const indexPath = join(distDirectory, 'index.html');

function fail(message) {
  process.stderr.write(`desktop bundle check failed: ${message}\n`);
  process.exit(1);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function declarationsFor(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rulePattern = new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'g');
  const declarations = new Map();
  let match;
  while ((match = rulePattern.exec(css)) !== null) {
    for (const declaration of match[1].split(';')) {
      const [property, ...value] = declaration.split(':');
      if (property && value.length > 0) {
        declarations.set(property.trim(), value.join(':').trim());
      }
    }
  }
  return declarations;
}

if (!existsSync(indexPath)) {
  fail(`missing build output at ${relative(repositoryRoot, indexPath)}; run pnpm --dir apps/desktop build first`);
}

const index = readFileSync(indexPath, 'utf8');
const assetReferences = [...index.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((reference) => reference.endsWith('.js') || reference.endsWith('.css'));

if (assetReferences.length === 0) {
  fail('generated index does not reference any JavaScript or CSS assets');
}

for (const reference of assetReferences) {
  if (reference.startsWith('/') || /^[a-z]+:/i.test(reference)) {
    fail(`asset URL must be relative for Tauri: ${reference}`);
  }
  const assetPath = join(distDirectory, reference.replace(/^\.\//, ''));
  if (!existsSync(assetPath)) {
    fail(`generated index references a missing asset: ${reference}`);
  }
}

const cssAssets = filesUnder(distDirectory).filter((path) => path.endsWith('.css'));
if (cssAssets.length === 0) {
  fail('generated build contains no stylesheet');
}

const css = cssAssets.map((path) => readFileSync(path, 'utf8')).join('\n');
const requiredLayout = [
  ['.app-shell', [['display', 'flex'], ['flex-direction', 'column']]],
  ['.app-body', [['display', 'flex'], ['flex', '1']]],
  ['.sidebar', [['display', 'flex'], ['flex-direction', 'column']]],
  ['.workspace', [['display', 'flex'], ['flex', '1']]],
];

if (!/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css)) {
  fail('[hidden] must include display: none !important in the built stylesheet');
}

for (const [selector, expectedDeclarations] of requiredLayout) {
  const declarations = declarationsFor(css, selector);
  for (const [property, expectedValue] of expectedDeclarations) {
    if (declarations.get(property) !== expectedValue) {
      fail(`${selector} must include ${property}: ${expectedValue} in the built stylesheet`);
    }
  }
}

process.stdout.write(`desktop bundle check passed (${assetReferences.length} referenced assets, ${cssAssets.length} stylesheet assets)\n`);
