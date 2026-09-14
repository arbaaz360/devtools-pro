#!/usr/bin/env node
// Deterministic local inputs for cargo acceptance and CLI benchmarks.
// Existing fixtures are preserved; allocation stays below one MiB per write.
import { existsSync, mkdirSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
const directory = resolve(process.argv[2] ?? 'benchmarks/fixtures');
mkdirSync(directory, { recursive: true });
function create(name, write) {
  const path = join(directory, name);
  if (existsSync(path)) return;
  const fd = openSync(path, 'wx');
  try { write(fd); } catch (error) { closeSync(fd); unlinkSync(path); throw error; }
  closeSync(fd);
  console.log(`Generated ${name}`);
}
for (const size of [50, 250]) create(`fixture-${size}mb.json`, fd => {
  writeSync(fd, '[');
  const row = JSON.stringify({ id: 1, payload: 'x'.repeat(480) });
  const batch = Buffer.from((row + ',').repeat(1024));
  let written = 1;
  while (written + batch.length + row.length + 1 < size * 1_000_000) {
    written += writeSync(fd, batch);
  }
  writeSync(fd, (row + ',').repeat(Math.ceil((size * 1_000_000 - written) / (row.length + 1))));
  writeSync(fd, row + ']');
});
for (const [name, text] of Object.entries({
  'bom.json': '\uFEFF{"bom":true}',
  'lexemes.json': '{"huge":123456789012345678901234567890,"n":1.2300e+100,"zero":-0,"dup":1,"dup":2,"escaped":"\\u0061","unicode":"café 東京"}',
  'malformed.json': '{"x":}',
  'trailing-content.json': '{"ok":true} false',
  'deep-1024.json': `${'['.repeat(1024)}0${']'.repeat(1024)}`,
  'long-string.json': `{"payload":"${'x'.repeat(1024 * 1024)}","after":true}`,
  'unclosed-quote.csv': 'id,note\r\n1,"unterminated',
  'ragged.csv': 'id,note\r\n1,ok\r\n2,extra,field\r\n',
  'mixed-newlines.txt': 'first café\r\nsecond 東京\nthird\rfourth',
})) create(name, fd => writeSync(fd, text));
create('invalid-utf8.json', fd => writeSync(fd, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])));
