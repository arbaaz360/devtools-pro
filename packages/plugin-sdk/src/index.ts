// The package entry is what processors import, and processors run in the
// desktop webview as well as under Node, so it exports only the browser-safe
// context. Node-only discovery is imported from ./discovery.ts directly.
export * from "./context.ts";
