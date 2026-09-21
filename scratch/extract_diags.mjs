import fs from 'fs';
import { execute } from '../plugins/jsx/processor.mjs';

const inputs = [
  "<script>const a = `{${b}}`;</script>",
  "<style>.a { color: red; }</style>",
  "<div><span>a",
  "<div><span>a</div>",
  "<div></div></span>",
  "<img src=\"a.png\"></img>",
  "<div><ul><li><p>abc",
  "<a><b></b></c>"
];

const sink = {
  count: 0,
  check() {},
  diagnostic(d) {
    if (!this.diags) this.diags = [];
    this.diags.push(d);
  },
  cancellation: { isCancelled: () => false }
};

for (const input of inputs) {
  sink.diags = [];
  try {
    execute({}, input, sink);
  } catch (e) { console.error(e); }
  console.log("INPUT:", input);
  console.log("DIAGS:", JSON.stringify(sink.diags));
}
