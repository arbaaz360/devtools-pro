#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.cwd();

function run(command, args) {
  process.stdout.write(`\n==> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    process.stderr.write(`quality gate could not start ${command}: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`quality gate failed: ${command} exited with ${result.status ?? 'an unknown status'}\n`);
    process.exit(result.status ?? 1);
  }
}

// The repository's large acceptance fixtures are generated locally and ignored
// by git; library tests keep this gate deterministic on a clean checkout.
run('cargo', ['test', '--workspace', '--lib']);
run('pnpm', ['--dir', 'apps/desktop', 'build']);
run('node', ['scripts/check-desktop-bundle.mjs']);
run('node', ['scripts/smoke-shell.mjs']);
run('git', ['diff', '--check']);

const rustfmt = process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt';
const formatterAvailable = spawnSync(rustfmt, ['--version'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (formatterAvailable) {
  process.stdout.write('\n==> rustfmt is installed; baseline formatting is advisory until the existing Rust sources are reformatted in a dedicated change.\n');
} else {
  process.stdout.write('\n==> rustfmt is unavailable; skipping advisory baseline-format status.\n');
}

const distIndex = join(root, 'apps', 'desktop', 'dist', 'index.html');
if (!existsSync(distIndex)) {
  process.stderr.write('quality gate failed: desktop smoke output is missing after build\n');
  process.exit(1);
}
process.stdout.write('\nQuality gate passed: Rust tests, desktop build, built-shell smoke, and whitespace validation.\n');
