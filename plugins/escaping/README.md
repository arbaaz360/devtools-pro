# Text Escaping

The v2 `text.escaping` package provides independent HTML entity, JSON string, and backslash escape/unescape operations. Inputs are read as UTF-8, source bytes are never changed, malformed sequences report an offset, and output/cancellation limits are enforced.
