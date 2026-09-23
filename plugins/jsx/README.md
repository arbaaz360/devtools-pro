# JSX Converter (DU-24)

Converts HTML and SVG snippets into JSX code. The output is formatted with customizable indentation and can be wrapped as a fragment or a complete functional component.

## Conversion Rules

- **Attribute Renaming**: Standard HTML attributes are renamed to their React-compliant camelCase equivalents. Examples include `class` to `className`, `for` to `htmlFor`, `tabindex` to `tabIndex`, `readonly` to `readOnly`, `colspan` to `colSpan`, and more. Event handlers like `onclick` are converted to `onClick`.
- **SVG Attributes**: By default (`svg-attributes: camel`), hyphenated and colon-separated SVG attributes are converted to camelCase (e.g. `stroke-width` becomes `strokeWidth`, `xlink:href` becomes `xlinkHref`). The `viewBox` attribute is preserved correctly. This conversion can be disabled by setting `svg-attributes: keep`.
- **Styles**: Inline `style` strings (e.g., `style="color: red; -webkit-user-select: none;"`) are parsed into React style objects `style={{ color: "red", WebkitUserSelect: "none" }}`. Vendor prefixes and typical CSS properties are appropriately camelCased, while numeric values are preserved as strings.
- **Boolean Attributes**: Common boolean attributes (like `disabled`, `checked`, `hidden`, `required`, etc.) without values are converted to just the attribute name (e.g. `<input disabled />`), whereas if they had a value (e.g. `disabled="true"`), the value is kept.
- **Void Elements**: HTML void elements (like `img`, `br`, `hr`, `input`, `meta`, etc.) and elements explicitly written as self-closing (`<x/>`) are always emitted as self-closing tags (`<img />`).
- **Comments**: HTML comments (`<!-- comment -->`) are converted to JSX block comments (`{/* comment */}`). Inside the comment, any `*/` is escaped to `* /` to prevent premature closure.
- **Text & Raw Elements**:
  - Curly braces `{` and `}` in text nodes are safely escaped to `{"{"}` and `{"}"}`.
  - `<script>` and `<style>` blocks emit their contents wrapped in a template literal inside a JSX expression block (``{`...`}``). Template literal syntax like `${...}` inside them is automatically escaped.

## Diagnostics

The converter produces structured `warning` diagnostics for malformed inputs (while still producing the best-effort output):
- **Stray End Tags**: A closing tag (`</x>`) without a matching opening tag is dropped.
- **Unclosed Elements**: An element that was left open at the end of the document is implicitly closed and reported.
- **Raw Blocks**: Using `<script>` or `<style>` blocks reports a warning that the content is being emitted as a template literal.
- **Empty Document**: Passing an empty document throws an error.

## Options

- `wrap`: Output wrapper. Choose from `none`, `fragment` (wraps in `<>...</>`), or `component` (wraps in `export default function Component() { return ( ... ); }`).
- `component-name`: The name of the component function (default `Component`). Must be a valid JavaScript identifier.
- `indent`: Indentation style. Accepts `2`, `4`, or `tab`.
- `svg-attributes`: Defines how SVG attributes are handled. Accepts `camel` (default) or `keep`.

## Preserving meaning (AG-129)

The converter must render the same text, attribute values and style declarations the
HTML has, not just something shaped like them:

- **Text beside an element.** JSX only keeps a text node's whitespace exactly as
  written when that text sits on a single source line; splitting it across lines (as a
  pretty-printer naturally would) lets JSX's own line-trimming eat a trailing or leading
  space. So whenever a run of children mixes text with an element — any element, not just
  a fixed inline set, since an unrecognized or custom tag beside text loses the same
  whitespace an `<a>` or `<b>` would — the whole run is emitted on one line, with runs of
  HTML whitespace in that text collapsed to a single space (matching how a browser renders
  it). Text-only or element-only content is still laid out however is clearest, since
  there is no adjacency to lose. `<pre>` content is emitted as a JS string expression
  (`{"…"}`) instead of raw JSX text, so its whitespace is never touched by JSX's own
  reflow rules.
- **Unquoted attribute values** end only at ASCII whitespace or `>`, as the HTML
  specification's unquoted-attribute-value state requires — `/` is part of the value, not
  a terminator (`<br class=a/>` has the value `a/`).
- **Style objects** keep what they were given: a custom property (`--anything`) keeps its
  name verbatim as a quoted key rather than being camelCased away, declarations split on
  `;` only outside parentheses and quotes (so a `url(data:image/png;base64,...)` or a
  quoted `"a;b"` value survives intact), and values are copied through unchanged.

This is verified against an independent oracle — the TypeScript compiler plus a minimal
`React.createElement` evaluator — in `test.mjs`, rather than by comparing the tool's
output against a recording of its own past output. A few of the plain fixtures in
`fixtures/` cover the same inputs for fast regression signal; they are pinned for
stability and their correctness is what the oracle test actually proves.
