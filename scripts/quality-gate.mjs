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

run('node', ['scripts/generate-fixtures.mjs']);
run('pnpm', ['--dir', 'packages/plugin-contract', 'check:generated']);
run('pnpm', ['--dir', 'packages/plugin-contract', 'test']);
run('pnpm', ['--dir', 'packages/plugin-sdk', 'test']);
run('pnpm', ['--dir', 'packages/plugin-sdk', 'headless', '../../plugins', '--plugin', 'examples.echo', '--input', 'input=quality-gate']);
run('cargo', ['test', '--workspace']);
run('cargo', ['run', '-p', 'devtools-plugin-discovery', '--', 'generate', 'plugins', 'target/generated/plugins']);
run('pnpm', ['--dir', 'apps/desktop', 'build']);
run('pnpm', ['--dir', 'apps/desktop', 'test:shell']);
run('pnpm', ['--dir', 'apps/desktop', 'test:ui']);
run('node', ['scripts/check-desktop-bundle.mjs']);
run('cargo', ['build', '-p', 'devtools-cli']);
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
process.stdout.write('\nQuality gate passed: Rust tests, desktop build, shell tests, built-shell smoke, and whitespace validation.\n');
