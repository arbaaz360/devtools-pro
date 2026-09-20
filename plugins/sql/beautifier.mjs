// A script to develop the beautifier logic
export function beautify(tokens, options, context) {
  let indentStr = options.indent === 'tab' ? '\t' : (options.indent === '4' ? '    ' : '  ');

  // Create a stream of clean tokens for easy lookahead
  const cleanTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'whitespace' && tokens[i].type !== 'comment') {
      cleanTokens.push({ token: tokens[i], origIndex: i, cleanIndex: cleanTokens.length });
    }
  }

  const MAJOR_CLAUSES = [
    ["LEFT", "OUTER", "JOIN"], ["RIGHT", "OUTER", "JOIN"], ["FULL", "OUTER", "JOIN"],
    ["GROUP", "BY"], ["ORDER", "BY"], ["UNION", "ALL"], ["INSERT", "INTO"], ["DELETE", "FROM"],
    ["CREATE", "TABLE"], ["ALTER", "TABLE"],
    ["INNER", "JOIN"], ["LEFT", "JOIN"], ["RIGHT", "JOIN"], ["FULL", "JOIN"], ["OUTER", "JOIN"],
    ["CROSS", "JOIN"], ["NATURAL", "JOIN"],
    ["SELECT"], ["FROM"], ["WHERE"], ["HAVING"], ["LIMIT"], ["OFFSET"], ["UNION"],
    ["VALUES"], ["UPDATE"], ["SET"], ["WITH"], ["JOIN"], ["ON"]
  ];

  for (let i = 0; i < cleanTokens.length; i++) {
    const ct = cleanTokens[i];
    if (ct.token.type === 'keyword') {
      for (const clause of MAJOR_CLAUSES) {
        let match = true;
        for (let j = 0; j < clause.length; j++) {
          if (i + j >= cleanTokens.length || cleanTokens[i+j].token.upper !== clause[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          ct.majorClause = clause;
          for (let j = 1; j < clause.length; j++) {
             cleanTokens[i+j].isPartOfMajorClause = true;
          }
          break;
        }
      }
    }
  }

  // Now we iterate original tokens and layout
  let out = "";
  let indentLevel = 0;
  let lineLength = 0; // Not exact, but good enough for inline heuristics if needed

  function getCase(t) {
    if (t.type !== 'keyword') return t.value;
    if (options.keywordCase === 'upper') return t.upper;
    if (options.keywordCase === 'lower') return t.upper.toLowerCase();
    return t.value;
  }

  return out;
}
