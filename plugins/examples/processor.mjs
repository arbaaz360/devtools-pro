export async function execute(_request, context) {
  let input = new TextEncoder().encode("hello from bundled plugin");
  try { input = await context.read("input"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("named input")) throw error; }
  await context.write("output", input);
}
