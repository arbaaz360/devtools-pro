# Hex Text

This package encodes text (its exact bytes) into hexadecimal and decodes hexadecimal back into bytes.

## Options

- `mode`: `encode` or `decode` (default `encode`)
- `case`: `lower` or `upper` (default `lower`). Encode only.
- `separator`: `none`, `space`, or `colon` (default `none`). Encode only.
- `bytes-per-line`: integer 0-256 (default `0`). Encode only. `0` means output is entirely on one line.

## Encoding

Encoding writes the input's exact bytes. A BOM, CRLF, NUL and invalid UTF-8 are all encoded as they are, never re-encoded through text.

## Decoding

Decoding accepts the following forms:
- Hexadecimal digits in either case (`a-f` or `A-F`)
- ASCII whitespace, `:`, `-`, or `,` between bytes
- `0x` or `0X` before each byte, or once before a run of digits
- `\x` before each byte (e.g. `\x48\x69`)

Each run of digits between separators must have an even length.

## Errors

Any violation of the above rules produces a structured error carrying the 0-based character offset of the first offending character:

- `hex.invalid-option`: An unknown option or wrong option type was provided.
- `hex.invalid-character`: A character outside the accepted forms was found.
- `hex.odd-length`: A run of hex digits has an odd length. The offset points to the start of that run.
