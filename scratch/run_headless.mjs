import { execFileSync } from 'child_process';

const out1 = execFileSync('node', [
  '--experimental-strip-types',
  'packages/plugin-sdk/scripts/headless.ts',
  'plugins',
  '--plugin',
  'convert.jsx',
  '--input',
  'input=<div class="card" style="margin-top: 4px; -webkit-user-select: none"><label for="x">Name</label><input id="x" disabled><br><!-- note --></div>'
]);
console.log("HEADLESS 1:\n" + out1.toString());

const out2 = execFileSync('node', [
  '--experimental-strip-types',
  'packages/plugin-sdk/scripts/headless.ts',
  'plugins',
  '--plugin',
  'convert.jsx',
  '--input',
  'input=<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" stroke-width="2"/></svg>',
  '--options',
  '{"wrap":"component","component-name":"Icon"}'
]);
console.log("\nHEADLESS 2:\n" + out2.toString());
