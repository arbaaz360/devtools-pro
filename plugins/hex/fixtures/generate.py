import json
import os

fixtures = []

def add_fixture(name, options, input_bytes, expected_output, error=None):
    if error:
        fixtures.append({
            "name": name,
            "options": options,
            "input": input_bytes.decode('latin-1'),
            "error": error
        })
    else:
        if options.get("mode", "encode") == "encode":
            fixtures.append({
                "name": name,
                "options": options,
                "input": input_bytes.decode('latin-1'),
                "output": expected_output.decode('latin-1')
            })
        else:
            fixtures.append({
                "name": name,
                "options": options,
                "input": input_bytes.decode('latin-1'),
                "output": expected_output.decode('latin-1')
            })

# Encode tests
tests_encode = [
    ("empty input", b""),
    ("ASCII", b"Hello"),
    ("UTF-8 2-byte", "é".encode("utf-8")),
    ("UTF-8 3-byte", "€".encode("utf-8")),
    ("UTF-8 4-byte", "🚀".encode("utf-8")),
    ("CRLF plus BOM", b"\xef\xbb\xbf\r\n"),
    ("all 256 bytes", bytes(range(256)))
]

for name, b in tests_encode:
    for case in ["lower", "upper"]:
        for separator in ["none", "space", "colon"]:
            for bpl in [0, 1, 16]:
                # Python's bytes.hex(sep, bytes_per_sep)
                # bytes.hex(sep) uses sep between each byte.
                # If we need bytes_per_line, we'll construct it manually.
                
                parts = []
                sep_str = ""
                if separator == "space": sep_str = " "
                elif separator == "colon": sep_str = ":"
                
                out = ""
                for i in range(len(b)):
                    hex_val = ("%02x" % b[i])
                    if case == "upper": hex_val = hex_val.upper()
                    out += hex_val
                    
                    if i < len(b) - 1:
                        if bpl > 0 and (i + 1) % bpl == 0:
                            out += "\n"
                        else:
                            out += sep_str
                            
                add_fixture(f"{name} case={case} sep={separator} bpl={bpl}", {
                    "mode": "encode",
                    "case": case,
                    "separator": separator,
                    "bytes-per-line": bpl
                }, b, out.encode("utf-8"))

# Decode tests
# accepted forms:
# whitespace between bytes
add_fixture("decode whitespace", {"mode": "decode"}, b"48 69\n74 68 65 72 65", bytes.fromhex("48 69 74 68 65 72 65"))
# - between bytes (python fromhex only accepts whitespace, so we strip -)
add_fixture("decode hyphen", {"mode": "decode"}, b"48-69-74", bytes.fromhex(b"48-69-74".replace(b"-", b"").decode("ascii")))
# : between bytes (strip :)
add_fixture("decode colon", {"mode": "decode"}, b"48:69:74", bytes.fromhex(b"48:69:74".replace(b":", b"").decode("ascii")))
# , between bytes (strip ,)
add_fixture("decode comma", {"mode": "decode"}, b"48,69,74", bytes.fromhex(b"48,69,74".replace(b",", b"").decode("ascii")))
# 0x before each byte
add_fixture("decode 0x before byte", {"mode": "decode"}, b"0x48 0x69", bytes.fromhex(b"0x48 0x69".replace(b"0x", b"").decode("ascii")))
# 0X before each byte
add_fixture("decode 0X before byte", {"mode": "decode"}, b"0X48 0X69", bytes.fromhex(b"0X48 0X69".replace(b"0X", b"").decode("ascii")))
# 0x once before run
add_fixture("decode 0x before run", {"mode": "decode"}, b"0x4869", bytes.fromhex(b"0x4869".replace(b"0x", b"").decode("ascii")))
# \x before each byte
add_fixture("decode \\x before byte", {"mode": "decode"}, b"\\x48\\x69", bytes.fromhex(b"\\x48\\x69".replace(b"\\x", b"").decode("ascii")))

# Error codes
add_fixture("error non-hex letter", {"mode": "decode"}, b"486g", None, {"code": "hex.invalid-character", "offset": 3})
add_fixture("error odd run middle", {"mode": "decode"}, b"48 6 90", None, {"code": "hex.odd-length", "offset": 3})
add_fixture("error odd run end", {"mode": "decode"}, b"486", None, {"code": "hex.odd-length", "offset": 0})

# Non-UTF-8 bytes labelled binary
add_fixture("decode non-utf8", {"mode": "decode"}, b"ff fe 00", bytes.fromhex("ff fe 00"))

# Write the fixtures
with open("plugins/hex/fixtures/test.json", "w", encoding="utf-8", newline="\n") as f:
    json.dump(fixtures, f, indent=2, ensure_ascii=False)

print(f"Generated {len(fixtures)} fixtures")
