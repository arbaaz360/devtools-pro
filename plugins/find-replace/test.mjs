import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "./processor.mjs";
import { CancellationToken, FixedClock, MemoryOutputSink, MemoryReader, MemorySecrets, ProcessorContext, SeededRandom } from "../../packages/plugin-sdk/src/context.ts";
async function run(options,input){const r=new MemoryReader().insert("input",input),source=r.inputs.get("input").slice(),out=new MemoryOutputSink(),c=new ProcessorContext(r,out,new CancellationToken(),new FixedClock("2025-01-01T00:00:00Z"),new SeededRandom(1),new MemorySecrets()); await execute({operationId:"text.find-replace",options},c); assert.deepEqual(r.inputs.get("input"),source); return out.values.get("output");}
test("literal Unicode find and bounded report",async()=>{const v=await run({query:"café",mode:"find"},"café café"); assert.equal(v.count,2); assert.deepEqual(v.matches.map(x=>x.start),[0,5]);});
test("replacement is literal",async()=>{const v=await run({query:"a.b",replacement:"$1\\n",mode:"replaceAll"},"a.b a.b"); assert.equal(v.text,"$1\\n $1\\n");});
