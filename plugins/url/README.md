# URL utilities plugin

This v2 bundled package exposes `text.url` for RFC 3986 component or HTML form percent encoding, and `web.url-parser` for query parsing. Decoding validates every percent escape and the resulting UTF-8. It never recursively decodes.

The parser accepts a raw query, a leading `?`, or an absolute URL. Repeated names preserve encounter order in arrays, blank values are retained, `+` means a form space, and encoded delimiters remain data. A terminal `[]` marks an array; deeper bracket syntax is deliberately preserved as a literal name until nesting semantics are specified.

Processors use only the public plugin SDK context. Reads, writes, parameter counts, and cooperative cancellation are bounded. The SDK has no processor diagnostic emitter in v2, so malformed input is surfaced as an execution error without a source span.

Run:

```text
node --experimental-strip-types --test plugins/url/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin web.url --operation url.transform --input "café /" --options '{"mode":"encode","encoding":"rfc3986"}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin web.url --operation url.parse-query --input "?a=1&a=2"
```
