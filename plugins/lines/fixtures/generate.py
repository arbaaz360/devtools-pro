import json
import re
import decimal

fixtures = []

def natural_key(s):
    runs = re.findall(r'[0-9]+|[^0-9]+', s)
    key = []
    for run in runs:
        if run.isdigit():
            key.append((0, int(run), len(run)))
        else:
            key.append((1, run))
    return tuple(key)

def numeric_key(s):
    m = re.match(r'^\s*([-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)', s)
    if m:
        return (0, decimal.Decimal(m.group(1)))
    return (1, s)

def case_insensitive_key(s):
    return s.lower()

def dedupe_lines(lines, ignore_case, ignore_whitespace):
    seen = set()
    result = []
    for line in lines:
        k = line
        if ignore_whitespace:
            k = k.strip()
        if ignore_case:
            k = k.lower()
        if k not in seen:
            seen.add(k)
            result.append(line)
    return result

def detect_ending(text):
    crlf = text.count('\r\n')
    lf = text.replace('\r\n', '').count('\n')
    cr = text.replace('\r\n', '').count('\r')
    if crlf > lf and crlf > cr:
        return '\r\n'
    elif cr > lf and cr > crlf:
        return '\r'
    return '\n'

def process(text, options):
    action = options.get("action", "sort")
    
    ending = detect_ending(text)
    has_trailing = text.endswith('\n') or text.endswith('\r')
    
    lines = re.split(r'\r\n|\n|\r', text) if text else []
    if has_trailing and lines:
        lines.pop()
    
    if action == "remove-blank":
        lines = [l for l in lines if l.strip()]
    elif action == "reverse":
        lines.reverse()
    elif action == "dedupe":
        lines = dedupe_lines(lines, options.get("ignore-case", False), options.get("ignore-whitespace", False))
    elif action == "sort":
        compare = options.get("compare", "natural")
        desc = options.get("order", "ascending") == "descending"
        
        if compare == "natural":
            lines.sort(key=natural_key, reverse=desc)
        elif compare == "numeric":
            lines.sort(key=numeric_key, reverse=desc)
        elif compare == "case-insensitive":
            lines.sort(key=case_insensitive_key, reverse=desc)
        else: # code-point
            lines.sort(reverse=desc)
    
    out = ending.join(lines)
    if has_trailing and lines:
        out += ending
        
    return out

def add_fixture(name, options, input_text):
    fixtures.append({
        "name": name,
        "options": options,
        "input": input_text,
        "output": process(input_text, options)
    })

# Cover: empty input; one line; a final newline present and absent;
add_fixture("empty input", {}, "")
add_fixture("one line", {}, "hello")
add_fixture("one line trailing", {}, "hello\n")

# CRLF, lone CR, and mixed endings
add_fixture("mixed endings CRLF majority", {}, "a\r\nb\r\nc\nd")
add_fixture("mixed endings CR majority", {}, "a\rb\rc\n\r\nd")
add_fixture("mixed endings LF majority", {}, "a\nb\nc\r\nd")

# the U+FF61/U+1F600 pair
add_fixture("code point surrogates", {"compare": "code-point"}, "\U0001f600\n\uff61")
add_fixture("code point surrogates desc", {"compare": "code-point", "order": "descending"}, "\uff61\n\U0001f600")

# a2/a02/a10/a1b/10/9, and digit runs longer than 20 digits
add_fixture("natural sort", {"compare": "natural"}, "a10\na02\na2\na1b\n10\n9")
add_fixture("natural sort long digits", {"compare": "natural"}, "10000000000000000000000000001\n10000000000000000000000000000")
add_fixture("natural sort non ascii digits", {"compare": "natural"}, "x10\nx٣\nx2")

# signed, fractional and exponent numbers, plus lines with none
add_fixture("numeric sort", {"compare": "numeric"}, "abc\n-1.5e2\n 42\n+0.5\nno number\n.9")
add_fixture("numeric sort desc", {"compare": "numeric", "order": "descending"}, "abc\n-1.5e2\n 42\n+0.5\nno number\n.9")
add_fixture("numeric exact 1", {"compare": "numeric"}, "123456789012345678901234567891\n123456789012345678901234567890")
add_fixture("numeric exact 2", {"compare": "numeric"}, "0.10000000000000000001\n0.1")
add_fixture("numeric exact 3", {"compare": "numeric"}, "1e-400\n0")
add_fixture("numeric exact 4", {"compare": "numeric"}, "2e308\n1e309")
add_fixture("numeric non ascii digits", {"compare": "numeric"}, "٣\n2\n10")

# case variants for dedupe with and without ignore-case, and whitespace variants with ignore-whitespace
add_fixture("dedupe default", {"action": "dedupe"}, "a\nA\n a \na")
add_fixture("dedupe ignore case", {"action": "dedupe", "ignore-case": True}, "a\nA\n a \na")
add_fixture("dedupe ignore whitespace", {"action": "dedupe", "ignore-whitespace": True}, "a\nA\n a \na")
add_fixture("dedupe both", {"action": "dedupe", "ignore-case": True, "ignore-whitespace": True}, "a\nA\n a \na")

# blank and whitespace-only lines for remove-blank
add_fixture("remove blank", {"action": "remove-blank"}, "a\n\n \n\t\nb")
add_fixture("remove blank trailing", {"action": "remove-blank"}, "a\n\n \n\t\n")

# descending with ties (stability)
add_fixture("descending stability", {"order": "descending", "compare": "numeric"}, "1 b\n1 a\n1 c")
add_fixture("descending stability exact", {"order": "descending", "compare": "numeric"}, "0 b\n-0 a\n+0.0 c\n0e5 d")

with open("plugins/lines/fixtures/test.json", "w", encoding="utf-8", newline="\n") as f:
    json.dump(fixtures, f, indent=2, ensure_ascii=False)

print(f"Generated {len(fixtures)} fixtures")
