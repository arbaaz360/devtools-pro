#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
// The root may be given relative to the repository or as an absolute path.
const pluginsPath = resolve(root, process.argv[2] || 'plugins');
const pluginsDir = relative(root, pluginsPath) || '.';

let packagesFound = 0;
let anyFailed = false;

let entries;
try {
  entries = readdirSync(pluginsPath);
} catch (e) {
  process.stderr.write(`could not read plugins directory: ${pluginsPath}\n`);
  process.exit(1);
}

const packages = entries.filter(name => {
  try {
    return statSync(join(pluginsPath, name)).isDirectory();
  } catch {
    return false;
  }
}).sort();

for (const pkg of packages) {
  const testFile = join(pluginsDir, pkg, 'test.mjs');
  try {
    if (!statSync(join(root, testFile)).isFile()) continue;
  } catch {
    continue;
  }

  packagesFound++;
  
  const result = spawnSync('node', ['--experimental-strip-types', '--test', testFile], {
    cwd: root,
    encoding: 'utf8'
  });

  if (result.error) {
    process.stdout.write(`${pkg}: failed to run (${result.error.message})\n`);
    anyFailed = true;
    continue;
  }

  const passMatch = result.stdout.match(/^[\sℹ#]*pass\s+(\d+)/m);
  const failMatch = result.stdout.match(/^[\sℹ#]*fail\s+(\d+)/m);
  
  const pass = passMatch ? passMatch[1] : '0';
  const fail = failMatch ? failMatch[1] : '0';

  const failed = result.status !== 0 || Number(fail) > 0;
  process.stdout.write(`${pkg}: ${pass} pass, ${fail} fail${failed && result.status !== 0 ? ` (exit ${result.status})` : ''}\n`);

  if (failed) {
    anyFailed = true;
    // Show the failing package's own report so a CI log names the test.
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
    if (detail) process.stdout.write(detail.split('\n').map((line) => `    ${line}`).join('\n') + '\n');
  }
}

if (packagesFound === 0) {
  process.stderr.write(`No test.mjs found in ${pluginsDir}\n`);
  process.exit(1);
}

if (anyFailed) {
  process.exit(1);
}
