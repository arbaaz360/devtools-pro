# Base64 Text

`encoding.base64-text` converts UTF-8 text using the public `ProcessorContext` boundary. Encode writes the complete Base64 text; decode validates the selected alphabet and padding before converting bytes back to UTF-8. Standard and URL-safe alphabets, required/omitted/optional padding, and strict/tolerant/replace error policies are explicit operation options.

The processor emits the complete text artifact on `output` and a structured value containing the selected policies, byte counts, text, and `complete: true`. Strict mode rejects whitespace, invalid characters, malformed padding, non-canonical trailing bits, and invalid UTF-8. Tolerant mode permits ASCII whitespace and omitted padding. Replace mode has the same Base64 validation as tolerant mode and replaces malformed UTF-8 with U+FFFD.

Run package checks from the repository root:

```text
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins/base64-text
node plugins/base64-text/test.mjs
```
