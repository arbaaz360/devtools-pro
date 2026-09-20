import { ProcessorCancelled } from "../../packages/plugin-sdk/src/index.ts";
import { words, firstNames, lastNames, domains } from "./words.mjs";

export class ExampleStringsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExampleStringsError";
    this.code = code;
    Object.assign(this, details);
  }
}

function randInt(max, context) {
  const bytes = new Uint8Array(4);
  context.randomness.fill(bytes);
  const val = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
  return val % max;
}

function pick(arr, context) {
  return arr[randInt(arr.length, context)];
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function generateWord(context) {
  return pick(words, context);
}

function generateSentence(context) {
  const len = 6 + randInt(9, context); // 6 to 14
  let res = [];
  for (let i = 0; i < len; i++) res.push(generateWord(context));
  res[0] = cap(res[0]);
  return res.join(" ") + ".";
}

function generateParagraph(context) {
  const len = 3 + randInt(4, context); // 3 to 6
  let res = [];
  for (let i = 0; i < len; i++) res.push(generateSentence(context));
  return res.join(" ");
}

function generateTitle(context) {
  const len = 3 + randInt(5, context); // 3 to 7
  let res = [];
  for (let i = 0; i < len; i++) res.push(cap(generateWord(context)));
  return res.join(" ");
}

function generateTweet(context, maxLen) {
  let tweet = "";
  while (true) {
    let s = generateSentence(context);
    if (tweet.length === 0 && s.length > maxLen) {
      continue;
    }
    const nextLen = tweet.length + (tweet.length > 0 ? 1 : 0) + s.length;
    if (nextLen <= maxLen) {
      tweet += (tweet.length > 0 ? " " : "") + s;
    } else {
      break;
    }
  }
  if (tweet.length === 0) {
    // fallback
    while (true) {
      let s = generateSentence(context);
      if (s.length <= maxLen) return s;
    }
  }
  return tweet;
}

function generateItem(category, context) {
  switch (category) {
    case "word": return generateWord(context);
    case "sentence": return generateSentence(context);
    case "paragraph": return generateParagraph(context);
    case "title": return generateTitle(context);
    case "first-name": return pick(firstNames, context);
    case "last-name": return pick(lastNames, context);
    case "full-name": return `${pick(firstNames, context)} ${pick(lastNames, context)}`;
    case "email": return `${pick(firstNames, context).toLowerCase()}.${pick(lastNames, context).toLowerCase()}@${pick(domains, context)}`;
    case "url": {
      const segCount = 1 + randInt(3, context); // 1 to 3
      let segs = [];
      for (let i = 0; i < segCount; i++) segs.push(generateWord(context));
      return `https://${pick(domains, context)}/${segs.join("-")}`;
    }
    case "short-tweet": return generateTweet(context, 140);
    case "long-tweet": return generateTweet(context, 280);
    default:
      throw new ExampleStringsError("unknown-category", `Unknown category: ${category}`);
  }
}

export async function execute(request, context) {
  const options = request?.options ?? {};

  const allowedKeys = ["category", "count"];
  for (const k of Object.keys(options)) {
    if (!allowedKeys.includes(k)) {
      throw new ExampleStringsError("unknown-option", `Unknown option key: ${k}`);
    }
  }

  const category = options.category ?? "sentence";

  let count = options.count ?? 1;
  if (typeof count === "string") count = parseInt(count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new ExampleStringsError("invalid-count", "Count must be an integer between 1 and 100");
  }

  const validCategories = ["paragraph", "sentence", "word", "title", "first-name", "last-name", "full-name", "email", "url", "short-tweet", "long-tweet"];
  if (!validCategories.includes(category)) {
    throw new ExampleStringsError("unknown-category", `Unknown category: ${category}`);
  }

  let items = [];
  for (let i = 0; i < count; i++) {
    if (context.cancellation.isCancelled()) {
      throw new ProcessorCancelled();
    }
    items.push(generateItem(category, context));
  }

  const text = items.join("\n");
  const maxOutputBytes = context.limits?.maxOutputBytes ?? 1048576;
  if (text.length > maxOutputBytes) {
    throw new ExampleStringsError("output-limit", `Result exceeds maximum output size limit of ${maxOutputBytes} bytes`);
  }

  const props = {
    category,
    count,
    items
  };

  await context.writeValue("output", props);
  if (text.length > 0) {
    await context.write("output", new TextEncoder().encode(text + "\n"));
  }

  return props;
}
