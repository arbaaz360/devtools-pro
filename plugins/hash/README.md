# Hash Generator

`encoding.hash` streams the named `input` document through six compatible digest algorithms and emits all results together: MD5, SHA-1, SHA-224, SHA-256, SHA-384 and SHA-512. Each output has a copyable hexadecimal text representation and a properties value containing the algorithm, digest, presentation case, input byte count, encoding and `complete: true`.

The `case` option only changes hexadecimal presentation (`lower` by default or `upper`); it never reruns or changes the input bytes. Input is consumed with the plugin SDK `ProcessorContext.readChunks` API, so host range readers can keep memory bounded. The SDK limit and cooperative cancellation checks are honored while reading.

MD2 and MD4 are intentionally omitted from this MVP because the available runtime does not provide authoritative implementations to verify against. They are not represented as placeholder algorithms. The included vectors cover empty bytes, ASCII, Unicode UTF-8 and CRLF byte identity.

These legacy hashes are compatibility/checksum tools and should not be used for password storage or secure signatures.
