import { readFileSync } from 'fs';
const src = readFileSync('plugins/js/processor.mjs', 'utf8');
const match = src.match(/function processTokens.*?^\}/ms);
if (match) {
  let fn = match[0];
  fn = fn.replace('while (i < len) {', 'let iters = 0; while (i < len) { if (iters++ > 10000) { console.log(\"Infinite loop at i=\", i, \"char=\", text[i]); break; }');
  eval(fn + ';\nconsole.log(processTokens(\"function foo(a, b) { return a + b; }\", \"none\"));');
} else {
  console.log(\"Could not find processTokens\");
}
