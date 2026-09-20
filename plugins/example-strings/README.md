# Example String Generator

`generate.examples` produces deterministic sample text in various formats (sentences, paragraphs, names, emails, URLs) using a seeded randomness source.

## Options

| Option | Choices | Default | Meaning |
|---|---|---|---|
| `category` | `paragraph`, `sentence`, `word`, `title`, `first-name`, `last-name`, `full-name`, `email`, `url`, `short-tweet`, `long-tweet` | `sentence` | The shape of the generated strings. |
| `count` | `1` to `100` | `1` | The number of examples to generate. |

Unknown options, an unknown category, or a count outside the 1–100 bounds are rejected with structured errors (`unknown-option`, `unknown-category`, `invalid-count`).

## Grammars and Shape Rules

The generator draws exclusively from its internal corpora and applies the following rules:

- **Word**: A single word from a lorem ipsum lexicon.
- **Sentence**: 6–14 words, where the first word is capitalised and the sentence ends in a full stop (`.`).
- **Paragraph**: 3–6 sentences joined by a single space.
- **Title**: 3–7 words, each title-cased.
- **First Name**: A random given name from a mixed-language corpus of 100 names.
- **Last Name**: A random surname from a mixed-language corpus of 100 names.
- **Full Name**: A first name and a last name separated by a space.
- **Email**: Lowercased format `first.last@domain`. Domains are restricted to `example.com`, `example.org`, and `example.net`.
- **URL**: Format `https://domain/path` where the domain is a reserved example domain, and the path is a 1–3 segment slug made of words joined by hyphens (`-`).
- **Short Tweet**: A block of sentences totaling at most 140 characters. Sentences are complete.
- **Long Tweet**: A block of sentences totaling at most 280 characters. Sentences are complete.

## Output

The result is returned on the `output` port.
- **Value representation (`properties`)**: An object containing `{ category, count, items }`.
- **Text representation**: The generated items joined by a newline (`\n`), trailing with an additional newline.

## Limits and Constraints

- **Input**: The operation has no required inputs and ignores documents. Source bytes remain immutable.
- **Output Limit**: Output limits are enforced before writing to the output port. If the size of the combined text output string exceeds the cap injected by the host scheduler, the operation is immediately aborted with an `output-limit` error.
- **Cancellation**: Cancellation boundaries are polled sequentially between each item generated.
- **Determinism**: Every item generation leverages the host-provided `context.randomness.fill()` interface explicitly, ensuring identical outputs given the same seed payload.

## Checks

From the repository root:

```text
node --experimental-strip-types --test plugins/example-strings/test.mjs
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin generate.examples --options '{"category":"paragraph","count":2}'
node --experimental-strip-types packages/plugin-sdk/scripts/headless.ts plugins --plugin generate.examples --options '{"category":"email","count":5}'
```
