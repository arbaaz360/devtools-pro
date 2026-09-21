const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";

function readStartTag(source, start) {
  const length = source.length;
  let j = start + 1;
  const nameStart = j;
  while (j < length && !isSpace(source[j]) && source[j] !== ">" && source[j] !== "/") j += 1;
  const rawName = source.slice(nameStart, j);
  const name = rawName.toLowerCase();
  const attrs = [];
  let selfClosing = false;
  let end = length;

  for (;;) {
    while (j < length && isSpace(source[j])) j += 1;
    if (j >= length) { end = length; break; }
    if (source[j] === ">") { end = j + 1; break; }
    if (source[j] === "/" && source[j + 1] === ">") { selfClosing = true; end = j + 2; break; }
    if (source[j] === "/") { j += 1; continue; }

    const attrStart = j;
    while (j < length && !isSpace(source[j]) && source[j] !== "=" && source[j] !== ">" && source[j] !== "/") j += 1;
    if (j === attrStart) { j += 1; continue; }
    const attrName = source.slice(attrStart, j);

    let k = j;
    while (k < length && isSpace(source[k])) k += 1;
    if (source[k] !== "=") { attrs.push({ rawName: attrName, name: attrName.toLowerCase(), value: null, quote: "" }); continue; }
    k += 1;
    while (k < length && isSpace(source[k])) k += 1;
    const quote = source[k];
    if (quote === "\"" || quote === "'") {
      const close = source.indexOf(quote, k + 1);
      const valueEnd = close < 0 ? length : close + 1;
      const valueRaw = source.slice(k + 1, close < 0 ? length : close);
      attrs.push({ rawName: attrName, name: attrName.toLowerCase(), value: valueRaw, quote });
      j = valueEnd;
      continue;
    }
    const valueStart = k;
    while (k < length && !isSpace(source[k]) && source[k] !== ">") k += 1;
    const valueRaw = source.slice(valueStart, k);
    attrs.push({ rawName: attrName, name: attrName.toLowerCase(), value: valueRaw, quote: "" });
    j = k;
  }
  return { kind: "startTag", start, end, name, rawName, attrs, selfClosing };
}

console.log(readStartTag('<path d="M0 0h24v24H0z" stroke-width="2"/>', 0));
