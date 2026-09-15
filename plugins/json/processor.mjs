export async function execute(request, context) {
  const input = new TextDecoder("utf-8", { fatal: true }).decode(await context.read("input"));
  let value;
  try { value = JSON.parse(input); }
  catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
  if (request.operationId === "inspect") {
    await context.writeValue("output", { valid: true, complete: true, inputBytes: new TextEncoder().encode(input).byteLength });
    return;
  }
  const output = request.operationId === "minify" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  await context.write("output", new TextEncoder().encode(output));
}
