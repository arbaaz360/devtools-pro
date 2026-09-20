const cases = [
  "userID_loaderHTTPServer v2Api",
  "ID",
  "API",
  "DB",
  "URL",
  "HTTP",
  "Ünïcödé",
  "Straße",
  "HTTPServer",
  "aB",
  "user_id"
];

function splitWords(s) {
  s = s.replace(/([\p{Ll}\p{M}])([\p{Lu}])/gu, "$1 $2");
  s = s.replace(/([\p{Lu}\p{M}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2");
  s = s.replace(/([\p{L}\p{M}])([\p{N}])/gu, "$1 $2");
  s = s.replace(/([\p{N}])([\p{L}\p{M}])/gu, "$1 $2");
  return Array.from(s.matchAll(/[\p{L}\p{N}\p{M}]+/gu)).map(m => m[0]);
}

function convert(word, index, target, isAcronym) {
  if (isAcronym) {
    if (target === 'camel' && index === 0) return word.toLowerCase();
    if (target === 'camel' || target === 'pascal') return word.toUpperCase();
    if (target === 'snake' || target === 'kebab') return word.toLowerCase();
    if (target === 'screaming-kebab' || target === 'constant') return word.toUpperCase();
  }

  if (target === 'camel') {
    if (index === 0) return word.toLowerCase();
    const chars = Array.from(word);
    return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
  }
  if (target === 'pascal') {
    const chars = Array.from(word);
    return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
  }
  if (target === 'snake' || target === 'kebab') {
    return word.toLowerCase();
  }
  if (target === 'screaming-kebab' || target === 'constant') {
    return word.toUpperCase();
  }
}

function convertLine(line, target, acronymsSet, preserveAcronyms) {
  const leadingMatch = line.match(/^\s*/);
  const trailingMatch = line.match(/\s*$/);
  const leading = leadingMatch[0];
  const trailing = trailingMatch[0];
  
  if (leading.length === line.length) return line; // blank line
  
  const middle = line.slice(leading.length, line.length - trailing.length);
  const words = splitWords(middle);
  
  let convertedWords = [];
  let acronymsApplied = 0;
  
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isAcronym = preserveAcronyms && acronymsSet.has(w.toUpperCase());
    if (isAcronym) acronymsApplied++;
    convertedWords.push(convert(w, i, target, isAcronym));
  }
  
  let sep = "";
  if (target === 'snake' || target === 'constant') sep = "_";
  if (target === 'kebab' || target === 'screaming-kebab') sep = "-";
  
  return leading + convertedWords.join(sep) + trailing;
}

const target = 'camel';
const acronymsSet = new Set(["ID", "API", "DB", "URL", "HTTP"]);

for (const c of cases) {
  console.log(`${c} -> ${convertLine(c, target, acronymsSet, true)}`);
}
