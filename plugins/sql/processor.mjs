import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";

export const OPERATION_ID_BEAUTIFY = "beautify";
export const OPERATION_ID_MINIFY = "minify";

export class SqlFormatterError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "SqlFormatterError";
    this.code = code;
    this.diagnostic = { code, severity: "error", message, data };
  }
}

function check(context) {
  if (context.cancellation.isCancelled()) throw new ProcessorCancelled();
}

function invalid(message, data) {
  return new SqlFormatterError("sql.invalid-option", message, data);
}

const KNOWN_OPTIONS = new Set(["dialect", "keyword-case", "keywordCase", "indent", "comma-position", "commaPosition"]);

export function normalizeOptions(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options must be an object", { received: Array.isArray(raw) ? "array" : typeof raw });
  for (const key of Object.keys(raw)) if (!KNOWN_OPTIONS.has(key)) throw invalid(`unknown option ${key}`, { option: key, known: [...KNOWN_OPTIONS] });

  const dialect = raw.dialect === undefined ? "sql" : raw.dialect;
  if (!["sql", "mysql", "mariadb", "postgresql", "plsql"].includes(dialect)) throw invalid(`dialect must be one of sql, mysql, mariadb, postgresql, plsql`, { option: "dialect", received: dialect });

  let keywordCase = "upper";
  if (raw["keyword-case"] !== undefined) keywordCase = raw["keyword-case"];
  else if (raw["keywordCase"] !== undefined) keywordCase = raw["keywordCase"];
  if (!["upper", "lower", "preserve"].includes(keywordCase)) throw invalid(`keyword-case must be one of upper, lower, preserve`, { option: "keyword-case", received: keywordCase });

  const indent = raw.indent === undefined ? "space-2" : raw.indent;
  if (!["space-2", "space-4", "tab", "2", "4"].includes(indent)) throw invalid(`indent must be one of space-2, space-4, tab`, { option: "indent", received: indent });

  let commaPosition = "end";
  if (raw["comma-position"] !== undefined) commaPosition = raw["comma-position"];
  else if (raw["commaPosition"] !== undefined) commaPosition = raw["commaPosition"];
  if (!["end", "start"].includes(commaPosition)) throw invalid(`comma-position must be one of end, start`, { option: "comma-position", received: commaPosition });

  return { dialect, keywordCase, indent, commaPosition };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

async function readText(context) {
  const chunks = [];
  let length = 0;
  for await (const chunk of context.readChunks("input", 65536)) {
    check(context);
    length += chunk.byteLength;
    if (length > context.limits.maxInputBytes) throw new SqlFormatterError("sql.input-limit", `input exceeds ${context.limits.maxInputBytes} bytes`, { bytes: length, limit: context.limits.maxInputBytes });
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = decoder.decode(bytes); } catch { throw new SqlFormatterError("sql.invalid-utf8", "input is not valid UTF-8 text", { bytes: length }); }
  return { text, inputBytes: length };
}

const ALL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT", "OFFSET",
  "UNION", "ALL", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE",
  "ALTER", "WITH", "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL",
  "AND", "OR", "CASE", "WHEN", "THEN", "ELSE", "END", "IN", "AS", "IS", "NOT", "NULL", "LIKE", "BETWEEN",
  "EXISTS", "CAST", "ASC", "DESC", "PRIMARY", "KEY", "INT", "VARCHAR", "CONSTRAINT", "FOREIGN", "REFERENCES", "DEFAULT", "UNIQUE", "INDEX"
]);

function tokenize(text, dialect, context) {
  const tokens = [];
  let i = 0;
  const len = text.length;
  let commentsCount = 0;
  let line = 1;

  while (i < len) {
    if (tokens.length % 4096 === 0) check(context);

    const c = text[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let start = i;
      let newlines = 0;
      while (i < len && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) {
        if (text[i] === '\n') { newlines++; line++; }
        i++;
      }
      tokens.push({ type: 'whitespace', value: text.substring(start, i), newlines });
      continue;
    }

    if ((c === '-' && text[i+1] === '-') || ((c === '#' && (dialect === 'mysql' || dialect === 'mariadb')))) {
      let start = i;
      while (i < len && text[i] !== '\n') i++;
      tokens.push({ type: 'comment', value: text.substring(start, i), isLineComment: true });
      commentsCount++;
      continue;
    }

    if (c === '/' && text[i+1] === '*') {
      let start = i;
      i += 2;
      while (i < len && !(text[i-1] === '*' && text[i] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      if (i < len) i++;
      tokens.push({ type: 'comment', value: text.substring(start, i), isLineComment: false });
      commentsCount++;
      continue;
    }

    if (c === "'") {
      let start = i;
      i++;
      while (i < len) {
        if (text[i] === '\n') line++;
        if (text[i] === "'") {
          if (text[i+1] === "'") i += 2;
          else { i++; break; }
        } else if (text[i] === '\\' && (dialect === 'mysql' || dialect === 'mariadb')) {
          i += 2;
        } else {
          i++;
        }
      }
      tokens.push({ type: 'string', value: text.substring(start, Math.min(i, len)) });
      continue;
    }

    if (c === '"' || c === '`' || (c === '[' && dialect === 'sql')) {
      let endChar = c === '[' ? ']' : c;
      let start = i;
      i++;
      while (i < len) {
        if (text[i] === '\n') line++;
        if (text[i] === endChar) {
          if (c !== '[' && text[i+1] === endChar) i += 2;
          else { i++; break; }
        } else {
          i++;
        }
      }
      tokens.push({ type: 'identifier', value: text.substring(start, Math.min(i, len)) });
      continue;
    }

    if (c === '$' && dialect === 'postgresql') {
      let match = text.substring(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (match) {
        let tag = match[0];
        let start = i;
        i += tag.length;
        let endIdx = text.indexOf(tag, i);
        if (endIdx !== -1) {
          for(let k = i; k < endIdx; k++) if(text[k] === '\n') line++;
          i = endIdx + tag.length;
        }
        else {
          for(let k = i; k < len; k++) if(text[k] === '\n') line++;
          i = len;
        }
        tokens.push({ type: 'string', value: text.substring(start, i) });
        continue;
      }
    }

    if (/[a-zA-Z_]/.test(c)) {
      let start = i;
      while (i < len && /[a-zA-Z0-9_$]/.test(text[i])) i++;
      let val = text.substring(start, i);
      let upper = val.toUpperCase();
      let type = ALL_KEYWORDS.has(upper) ? 'keyword' : 'identifier';
      tokens.push({ type, value: val, upper });
      continue;
    }

    let numMatch = text.substring(i).match(/^(0x[0-9a-fA-F]+|[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?|\.[0-9]+(e[+-]?[0-9]+)?)/);
    if (numMatch) {
      let start = i;
      i += numMatch[0].length;
      tokens.push({ type: 'number', value: text.substring(start, i) });
      continue;
    }

    let ops3 = ['->>', '<<=', '>>='];
    let ops2 = ['<>', '!=', '<=', '>=', '||', '->', '::', '<<', '>>', '==', '=>', ':='];
    let sub3 = text.substring(i, i+3);
    if (ops3.includes(sub3)) {
      tokens.push({ type: 'operator', value: sub3 });
      i += 3;
      continue;
    }
    let sub2 = text.substring(i, i+2);
    if (ops2.includes(sub2)) {
      tokens.push({ type: 'operator', value: sub2 });
      i += 2;
      continue;
    }

    if (c === '=' || c === '<' || c === '>' || c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '&' || c === '|' || c === '^' || c === '~') {
       tokens.push({ type: 'operator', value: c });
       i++;
       continue;
    }

    if (c === '?' || c === ':' || c === '$' || c === '@') {
      let start = i;
      i++;
      while (i < len && /[a-zA-Z0-9_]/.test(text[i])) i++;
      if (i > start + 1 || c === '?') {
        tokens.push({ type: 'parameter', value: text.substring(start, i) });
        continue;
      }
      i = start;
    }

    tokens.push({ type: 'symbol', value: c });
    i++;
  }
  return { tokens, commentsCount };
}

function processTokens(tokens, options, isMinify, context) {
  let indentStr = options.indent === 'tab' ? '\t' : (options.indent === '4' ? '    ' : '  ');

  if (isMinify) {
    let out = "";
    let lastNeedsSpace = false;
    let statements = 1;
    for (let i = 0; i < tokens.length; i++) {
      if (i % 4096 === 0) check(context);
      const t = tokens[i];
      if (t.type === 'whitespace') continue;
      if (t.type === 'symbol' && t.value === ';') statements++;

      if (t.type === 'comment') {
        if (lastNeedsSpace) out += " ";
        out += t.value;
        if (t.isLineComment) out += "\n";
        lastNeedsSpace = false;
        continue;
      }

      let needsSpace = (t.type === 'identifier' || t.type === 'keyword' || t.type === 'number' || t.type === 'parameter' || (t.type === 'operator' && /^[a-zA-Z]/.test(t.value)) || (t.type === 'string' && t.value.startsWith('$')));
      if (lastNeedsSpace && needsSpace) {
        out += " ";
      }
      out += t.value;
      lastNeedsSpace = needsSpace;
    }
    return { output: out, statements };
  }

  // Beautifier
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

  let out = "";
  let indentLevel = 0;
  let statements = 1;
  let newlinesToEmit = 0;
  let inSelectList = false;
  let inSetList = false;
  let listContext = []; // stack of current context

  function getCase(t) {
    if (t.type !== 'keyword') return t.value;
    if (options.keywordCase === 'upper') return t.upper;
    if (options.keywordCase === 'lower') return t.upper.toLowerCase();
    return t.value;
  }

  function emitNewline() {
    if (out.length > 0) newlinesToEmit = Math.max(newlinesToEmit, 1);
  }
  function emitBlankLine() {
    if (out.length > 0) newlinesToEmit = Math.max(newlinesToEmit, 2);
  }

  function emitWhitespace() {
    // We now just use this for the base emitWhitespace cases, but the main loop handles it directly for tokens.
  }

  // A helper to know if a comma belongs to a list that should wrap
  function shouldWrapComma() {
    // If we are in SELECT, SET, VALUES or an IN list that wrapped
    if (listContext.length > 0) {
      const top = listContext[listContext.length - 1];
      if (top === 'SELECT' || top === 'SET' || top === 'VALUES' || top === 'WRAPPED_PARENS') {
        return true;
      }
    }
    return false;
  }

  // Get inline length for IN (...)
  function getInlineLength(cleanIdx) {
    let len = 0;
    let depth = 0;
    for (let k = cleanIdx; k < cleanTokens.length; k++) {
      let t = cleanTokens[k].token;
      len += t.value.length;
      if (t.value === '(') depth++;
      else if (t.value === ')') {
        depth--;
        if (depth === 0) return len;
      }
    }
    return 1000;
  }

  let lastOrigOutputIdx = -1;
  let lastWasSpace = false;

  for (let i = 0; i < tokens.length; i++) {
    if (i % 4096 === 0) check(context);
    let t = tokens[i];

    if (t.type === 'whitespace') continue; // We manage spacing manually

    if (t.type === 'comment') {
      let wasNewline = false;
      if (i > 0 && tokens[i-1].type === 'whitespace' && tokens[i-1].newlines > 0) wasNewline = true;
      if (wasNewline) {
        emitNewline();
      } else {
        if (out.length > 0 && out[out.length - 1] !== ' ' && out[out.length - 1] !== '\n') {
          out += ' ';
        }
      }

      if (newlinesToEmit > 0) {
        out = out.replace(/[ \t]+$/, '');
        for (let k = 0; k < newlinesToEmit; k++) out += '\n';
        out += indentStr.repeat(Math.max(0, indentLevel));
        newlinesToEmit = 0;
      }

      out += t.value;
      if (t.isLineComment) emitNewline();
      continue;
    }

    let ct = cleanTokens.find(c => c.origIndex === i);
    let isMajor = ct && ct.majorClause !== undefined && !ct.isPartOfMajorClause;

    if (isMajor) {
      let kw = ct.majorClause[0];
      let oldTop = listContext[listContext.length - 1];
      if (oldTop === 'SELECT' || oldTop === 'SET' || oldTop === 'VALUES') {
        listContext.pop();
        indentLevel = Math.max(0, indentLevel - 1);
      }

      emitNewline();
    }

    // AND / OR
    let extraIndent = 0;
    if (t.type === 'keyword' && (t.upper === 'AND' || t.upper === 'OR')) {
      extraIndent = 1;
      emitNewline();
    }

    if (t.type === 'keyword' && (t.upper === 'WHEN' || t.upper === 'ELSE' || t.upper === 'END')) {
      if (t.upper === 'END') {
        if (listContext[listContext.length - 1] === 'CASE') {
          listContext.pop();
          indentLevel = Math.max(0, indentLevel - 1);
        }
      }
      emitNewline();
    }

    // Split statements on ;
    if (t.value === ';') {
      statements++;
    }

    if (t.value === ')') {
      let top = listContext[listContext.length - 1];
      if (top === 'SUBSELECT' || top === 'WRAPPED_PARENS') {
        listContext.pop();
        indentLevel = Math.max(0, indentLevel - 1);
        emitNewline();
      } else if (top === 'INLINE_PARENS') {
        listContext.pop();
      }
    }

    // Comma handling
    if (t.value === ',') {
      if (options.commaPosition === 'start' && shouldWrapComma()) {
        emitNewline();
      } else if (options.commaPosition === 'end' && shouldWrapComma()) {
        // newline after comma
      }
    }

    // Add necessary spacing before token
    if (out.length > 0 && newlinesToEmit === 0) {
      let lastChar = out[out.length - 1];
      let needsSpace = false;
      if (lastChar !== ' ' && lastChar !== '\n' && lastChar !== '(' && lastChar !== '[' && t.value !== ')' && t.value !== ',' && t.value !== ';') {
        let prevCt = cleanTokens[ct.cleanIndex - 1];
        if (prevCt && (
           (t.type === 'operator' || prevCt.token.type === 'operator' || t.value === '=' || prevCt.token.value === '=') ||
           (t.type === 'keyword' || prevCt.token.type === 'keyword') ||
           (t.type === 'identifier' && prevCt.token.type === 'identifier') ||
           (t.type === 'number' && prevCt.token.type === 'number') ||
           (t.type === 'parameter' && prevCt.token.type === 'parameter') ||
           (t.type === 'identifier' && prevCt.token.type === 'number') ||
           (t.type === 'number' && prevCt.token.type === 'identifier') ||
           (t.type === 'identifier' && prevCt.token.type === 'keyword') ||
           (t.type === 'keyword' && prevCt.token.type === 'identifier')
        )) {
          needsSpace = true;
        }
        if (lastChar === ',') needsSpace = true;

        if (prevCt && t.value === '(') {
           if (prevCt.token.type === 'identifier') needsSpace = false;
           else if (prevCt.token.type === 'keyword') {
              let kw = prevCt.token.upper;
              if (kw === 'VARCHAR' || kw === 'INT' || kw === 'CHAR') needsSpace = false;
           }
        }
      }
      if (needsSpace) out += ' ';
    }

    // Custom emitWhitespace to include extraIndent
    if (newlinesToEmit > 0) {
      out = out.replace(/[ \t]+$/, '');
      for (let k = 0; k < newlinesToEmit; k++) out += '\n';
      out += indentStr.repeat(Math.max(0, indentLevel + extraIndent));
      newlinesToEmit = 0;
    }

    out += getCase(t);

    // AFTER PRINTING
    if (t.type === 'keyword' && t.upper === 'CASE') {
      listContext.push('CASE');
      indentLevel++;
    }

    if (t.value === '(') {
      let nextCt = cleanTokens[ct.cleanIndex + 1];
      let isSubSelect = nextCt && nextCt.token.type === 'keyword' && nextCt.token.upper === 'SELECT';
      let prevCt = cleanTokens[ct.cleanIndex - 1];
      let isIN = prevCt && prevCt.token.type === 'keyword' && prevCt.token.upper === 'IN';

      if (isSubSelect) {
        listContext.push('SUBSELECT');
        indentLevel++;
      } else if (isIN && getInlineLength(ct.cleanIndex) >= 60) {
        listContext.push('WRAPPED_PARENS');
        indentLevel++;
      } else {
        listContext.push('INLINE_PARENS');
      }
    }

    if (t.value === ',') {
      if (options.commaPosition === 'end' && shouldWrapComma()) {
        newlinesToEmit = 1;
      }
    }
    // Special: Comma position start formatting check
    // If commaPosition is start, and this item is the start of a new line in a list, we might have emitted a newline.

    if (isMajor) {
      let kw = ct.majorClause[0];
      if (kw === 'SELECT') { listContext.push('SELECT'); indentLevel++; newlinesToEmit = 1; }
      else if (kw === 'SET') { listContext.push('SET'); indentLevel++; newlinesToEmit = 1; }
      else if (kw === 'VALUES') { listContext.push('VALUES'); indentLevel++; newlinesToEmit = 1; }
    }

    if (t.value === ';') {
      listContext = [];
      indentLevel = 0;
      emitBlankLine();
    }
  }

  return { output: out.trimEnd(), statements };
}

export async function execute(request, context) {
  check(context);
  if (request?.operationId !== OPERATION_ID_BEAUTIFY && request?.operationId !== OPERATION_ID_MINIFY) {
    throw new SqlFormatterError("sql.unsupported-operation", `unsupported operation ${request.operationId}`, { operationId: request.operationId, supported: [OPERATION_ID_BEAUTIFY, OPERATION_ID_MINIFY] });
  }
  const isMinify = request.operationId === OPERATION_ID_MINIFY;
  const options = normalizeOptions(request?.options);
  const { text, inputBytes } = await readText(context);

  const { tokens, commentsCount } = tokenize(text, options.dialect, context);
  const { output, statements } = processTokens(tokens, options, isMinify, context);

  const outputBytes = encoder.encode(output);
  if (outputBytes.byteLength > context.limits.maxOutputBytes) {
    throw new SqlFormatterError("sql.output-limit", `output exceeds ${context.limits.maxOutputBytes} bytes`, { bytes: outputBytes.byteLength, limit: context.limits.maxOutputBytes });
  }

  const report = {
    statements,
    tokens: tokens.length,
    comments: commentsCount,
    keywordCase: options.keywordCase,
    dialect: options.dialect,
    bytes: outputBytes.byteLength
  };

  await context.writeValue("output", report);
  await context.write("output", outputBytes);
  return report;
}
