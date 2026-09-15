import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./processor.mjs";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
async function run(operationId, options, input){const r=new MemoryReader().insert("input",input), source=r.inputs.get("input").slice(), out=new MemoryOutputSink(); const c=new ProcessorContext(r,out,new CancellationToken(),new FixedClock("2025-01-01T00:00:00Z"),new SeededRandom(1),new MemorySecrets()); await execute({operationId,options},c); assert.deepEqual(r.inputs.get("input"),source); return new TextDecoder().decode(out.bytes.get("output"));}
test("HTML entities round trip",async()=>{const e=await run("text.html",{mode:"escape"},`<é & "x">`); assert.equal(e,"&lt;&#233; &amp; &quot;x&quot;&gt;"); assert.equal(await run("text.html",{mode:"unescape"},e),`<é & "x">`);});
test("JSON string and backslash round trips",async()=>{const s="line\n\"é"; assert.equal(await run("text.json-string",{mode:"unescape"},await run("text.json-string",{mode:"escape"},s)),s); assert.equal(await run("text.backslash",{mode:"unescape"},await run("text.backslash",{mode:"escape"},s)),s);});
test("malformed diagnostics",async()=>{await assert.rejects(()=>run("text.backslash",{mode:"unescape"},"\\u12"),/four hexadecimal/); await assert.rejects(()=>run("text.json-string",{mode:"unescape"},"bad"),/malformed/);});
