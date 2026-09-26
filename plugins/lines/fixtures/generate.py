import json
import re

fixtures = []

def natural_key(s):
    runs = re.findall(r'\d+|\D+', s)
    key = []
    for run in runs:
        if run.isdigit():
            key.append((0, int(run), len(run)))
        else:
            key.append((1, run))
    return tuple(key)

def numeric_key(s):
    m = re.match(r'^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)', s)
    if m:
        return (0, float(m.group(1)))
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
    
    lines = re.split(r'\r\n|\n|\r', text)
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
        
        # Python's sort is stable. 
        # When descending is true, we reverse the sort order but MUST preserve stability (equal keys keep original order).
        # Python's `sorted(reverse=True)` does not preserve stability for equal keys (it reverses their order).
        # Wait! Python's `sorted(reverse=True)` IS stable. Elements with equal keys keep their original order!
        # Let's verify: sorted([(1, 'a'), (1, 'b')], key=lambda x: x[0], reverse=True) -> [(1, 'a'), (1, 'b')]
        # So `sorted(reverse=True)` is stable in Python!
        
        if compare == "natural":
            lines.sort(key=natural_key, reverse=desc)
        elif compare == "numeric":
            lines.sort(key=numeric_key, reverse=desc)
        elif compare == "case-insensitive":
            lines.sort(key=case_insensitive_key, reverse=desc)
        else: # code-point
            lines.sort(reverse=desc)
    
    out = ending.join(lines)
    if has_trailing and (lines or action != "remove-blank"):
        # if input was blank lines and we removed them, if lines is empty, does it keep trailing?
        # "A final line ending in the input is kept, present or absent."
        # However, if output has no lines and has_trailing, adding ending makes it 1 blank line. 
        # Wait, if remove-blank is used and all lines are removed, output should be empty string!
        # So we only add trailing if lines is not empty, OR if action is not remove-blank.
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

# signed, fractional and exponent numbers, plus lines with none
add_fixture("numeric sort", {"compare": "numeric"}, "abc\n-1.5e2\n 42\n+0.5\nno number\n.9")
add_fixture("numeric sort desc", {"compare": "numeric", "order": "descending"}, "abc\n-1.5e2\n 42\n+0.5\nno number\n.9")

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

with open("plugins/lines/fixtures/test.json", "w", encoding="utf-8", newline="\n") as f:
    json.dump(fixtures, f, indent=2, ensure_ascii=False)

print(f"Generated {len(fixtures)} fixtures")
