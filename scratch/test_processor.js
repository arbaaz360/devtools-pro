
import { tokenize, buildTree } from "../plugins/jsx/processor.mjs";
const diagnostics = [];
const sink = { check: () => {}, count: 0, diagnostic: (d) => diagnostics.push(d) };
const text = `<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" stroke-width="2"/></svg>`;
const { tokens } = tokenize(text, sink);
console.log(tokens);
const root = buildTree(tokens, sink);
console.log(diagnostics);

