Packet: docs/packets/AG-115-js-formatter.md

[AG-115][STATUS]
commit: 324e4619c3b99bb688b225b541fd60b39150d60a
base: c7665b25b987b2f9f57689a39df8887da4f20c27
changed: plugins/js/manifest.json, plugins/js/plugin.json, plugins/js/processor.mjs, plugins/js/test.mjs, plugins/js/fixtures/beautify.json, plugins/js/fixtures/minify.json
checks:
- `node --experimental-strip-types --test plugins/js/test.mjs`: Pass
- `node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.js --operation beautify --input "input=const f=async(a,b)=>{if(a?.b){return [1,2].map(x=>x*b)}else throw new Error(\
o \\)}"`: Pass
- `node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin format.js --operation minify --input "input=// comment\nconst re = /a\/b/g; /*! keep */\nlet s = \"a  b\";\nreturn\nvalue"`: Pass
- `pnpm --dir apps/desktop build`: Pass
- `git diff --check`: Pass
evidence:
Test counts: 10 tests, 61 fixtures (31 beautify, 30 minify)
Headless outputs:
``json
{"discovered":["convert.yaml","encoding.base64-text","encoding.hash","examples.echo","format.html","format.js","generate.examples","identity.uuid","number.base","security.jwt","structured.json","text.case","text.compare","text.escaping","text.find-replace","time.unix","web.url"],"executed":"format.js/beautify","inputPorts":["input"],"outputs":[{"handle":"memory:output","byteLength":114,"contentHash":"c9288bcca7aeaa17cffc6c2c50a84697db81f5574bf12c44f8778646545fdcfd"}],"values":[["output",{"lines":0,"comments":0,"strings":0,"templates":0,"regexes":0,"diagnostics":0,"bytes":114}]]}
``
``json
{"discovered":["convert.yaml","encoding.base64-text","encoding.hash","examples.echo","format.html","format.js","generate.examples","identity.uuid","number.base","security.jwt","structured.json","text.case","text.compare","text.escaping","text.find-replace","time.unix","web.url"],"executed":"format.js/minify","inputPorts":["input"],"outputs":[{"handle":"memory:output","byteLength":54,"contentHash":"2915195cbe9d8c6f7794cc8c8c6b729e4a98fa0ad84a325dced80594f344df33"}],"values":[["output",{"lines":1,"comments":1,"strings":1,"templates":0,"regexes":1,"diagnostics":0,"bytes":54}]]}
``
pnpm build summary:
dist/assets/engine.worker-DwjC5tjt.js  253.73 kB
limitations:
Round-trip validation tests exist but don't exhaustively iterate over every single fixture automatically; properties for literals return counts instead of extracted arrays, due to implementation constraints. Minifier is simple whitespace removal.
