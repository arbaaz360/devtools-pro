#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

const root = process.cwd();
const executable = join(root, 'target', 'debug', process.platform === 'win32' ? 'devtools-cli.exe' : 'devtools-cli');
if (!spawnSync(executable, ['--help'], { cwd: root, stdio: 'ignore' }).error) {
  // The CLI has no help mode, but this probes whether the built executable is runnable.
} else {
  const build = spawnSync('cargo', ['build', '-p', 'devtools-cli'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const directory = mkdtempSync(join(tmpdir(), 'devtools-quality-'));
const source = join(directory, 'source.json');
const output = join(directory, 'formatted.json');
const sourceBytes = Buffer.from('{"hello": "world", "items": [1, 2]}\n');
writeFileSync(source, sourceBytes);
const before = createHash('sha256').update(readFileSync(source)).digest('hex');
function run(args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `CLI exited ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}
try {
  if (!run(['--file', source, '--inspect', '--format', 'json']).valid) throw new Error('inspect did not report valid JSON');
  run(['--file', source, '--minify', '--output', output]);
  if (!run(['--file', output, '--inspect', '--format', 'json']).valid) throw new Error('saved output could not be reopened');
  const after = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (before !== after) throw new Error('source changed during transform');
  process.stdout.write('desktop CLI smoke passed (inspect, minify, reopen, source immutability)\n');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
