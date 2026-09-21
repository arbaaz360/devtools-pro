import * as fs from "fs";
import * as crypto from "crypto";

const OPERATION = "convert.jsx";

const TESTS = [
  // Wrap Options
  { desc: "wrap none", opts: { wrap: "none" }, in: "<div>a</div>", out: "<div>\n  a\n</div>" },
  { desc: "wrap fragment", opts: { wrap: "fragment" }, in: "<div>a</div>", out: "<>\n  <div>\n    a\n  </div>\n</>" },
  { desc: "wrap component", opts: { wrap: "component", "component-name": "MyComp" }, in: "<div>a</div>", out: "export default function MyComp() {\n  return (\n    <>\n      <div>\n        a\n      </div>\n    </>\n  );\n}" },

  // Indent Options
  { desc: "indent 4 spaces", opts: { indent: "spaces-4" }, in: "<div><span>a</span></div>", out: "<>\n    <div>\n        <span>\n            a\n        </span>\n    </div>\n</>" },
  { desc: "indent tab", opts: { indent: "tab" }, in: "<div><span>a</span></div>", out: "<>\n\t<div>\n\t\t<span>\n\t\t\ta\n\t\t</span>\n\t</div>\n</>" },
  
  // HTML Attributes renaming
  { desc: "class to className", in: "<div class=\"a\"></div>", out: "<>\n  <div className=\"a\" />\n</>" },
  { desc: "for to htmlFor", in: "<label for=\"a\">a</label>", out: "<>\n  <label htmlFor=\"a\">\n    a\n  </label>\n</>" },
  { desc: "tabindex to tabIndex", in: "<div tabindex=\"0\"></div>", out: "<>\n  <div tabIndex=\"0\" />\n</>" },
  { desc: "multiple renames", in: "<input readonly maxlength=\"5\" colspan=\"2\" rowspan=\"3\" autocomplete=\"off\" autofocus enctype=\"abc\" />", out: "<>\n  <input readOnly maxLength=\"5\" colSpan=\"2\" rowSpan=\"3\" autoComplete=\"off\" autoFocus encType=\"abc\" />\n</>" },
  { desc: "more renames", in: "<form accept-charset=\"utf8\" novalidate><input formnovalidate inputmode=\"text\" minlength=\"1\" /></form>", out: "<>\n  <form acceptCharset=\"utf8\" noValidate>\n    <input formNoValidate=\"true\" inputMode=\"text\" minLength=\"1\" />\n  </form>\n</>" },
  { desc: "even more renames", in: "<iframe frameborder=\"0\" allowfullscreen></iframe><time datetime=\"2024\"></time>", out: "<>\n  <iframe frameBorder=\"0\" allowFullScreen=\"true\" />\n  <time dateTime=\"2024\" />\n</>" },
  { desc: "attributes part 4", in: "<meta http-equiv=\"refresh\" crossorigin=\"anonymous\"><img srcset=\"a.png\" usemap=\"#a\">", out: "<>\n  <meta httpEquiv=\"refresh\" crossOrigin=\"anonymous\" />\n  <img srcSet=\"a.png\" useMap=\"#a\" />\n</>" },
  { desc: "attributes part 5", in: "<div contenteditable spellcheck accesskey=\"s\" hreflang=\"en\" playsinline referrerpolicy=\"no-referrer\"></div>", out: "<>\n  <div contentEditable=\"true\" spellCheck=\"true\" accessKey=\"s\" hrefLang=\"en\" playsInline=\"true\" referrerPolicy=\"no-referrer\" />\n</>" },

  // Event handlers
  { desc: "event handlers", in: "<button onclick=\"a()\" onmouseover=\"b()\" onkeydown=\"c()\">A</button>", out: "<>\n  <button onClick=\"a()\" onMouseover=\"b()\" onKeydown=\"c()\">\n    A\n  </button>\n</>" },
  
  // Boolean Attributes
  { desc: "boolean attributes without values", in: "<input disabled checked selected hidden required readonly multiple autofocus autoplay controls loop muted open defer async novalidate />", out: "<>\n  <input disabled checked selected hidden required readOnly multiple autoFocus autoplay controls loop muted open defer async noValidate />\n</>" },

  // Void elements
  { desc: "void elements are self closing", in: "<area><base><br><col><embed><hr><img><input><link><meta><source><track><wbr>", out: "<>\n  <area />\n  <base />\n  <br />\n  <col />\n  <embed />\n  <hr />\n  <img />\n  <input />\n  <link />\n  <meta />\n  <source />\n  <track />\n  <wbr />\n</>" },

  // Style parsing
  { desc: "style parsing basic", in: "<div style=\"color: red; margin-top: 10px;\"></div>", out: "<>\n  <div style={{ color: \"red\", marginTop: \"10px\" }} />\n</>" },
  { desc: "style parsing vendor prefixes", in: "<div style=\"-ms-user-select: none; -webkit-transform: scale(1); -moz-box-sizing: border-box; -o-transition: all;\"></div>", out: "<>\n  <div style={{ msUserSelect: \"none\", WebkitTransform: \"scale(1)\", MozBoxSizing: \"border-box\", OTransition: \"all\" }} />\n</>" },
  { desc: "style parsing numbers as strings", in: "<div style=\"width: 100; z-index: 5\"></div>", out: "<>\n  <div style={{ width: \"100\", zIndex: \"5\" }} />\n</>" },

  // Comments
  { desc: "comments", in: "<!-- hello world --><div><!-- nested comment --></div>", out: "<>\n  {/* hello world */}\n  <div>\n    {/* nested comment */}\n  </div>\n</>" },
  { desc: "comment escaping block", in: "<!-- /* inside */ -->", out: "<>\n  {/* /* inside * / */}\n</>" },

  // SVG attributes
  { desc: "svg attributes default camelCase", in: "<svg viewBox=\"0 0 10 10\"><path stroke-width=\"2\" xlink:href=\"#abc\" xml:space=\"preserve\" /></svg>", out: "<>\n  <svg viewBox=\"0 0 10 10\">\n    <path strokeWidth=\"2\" xlinkHref=\"#abc\" xmlSpace=\"preserve\" />\n  </svg>\n</>" },
  { desc: "svg attributes keep", opts: { "svg-attributes": "keep" }, in: "<svg viewBox=\"0 0 10 10\"><path stroke-width=\"2\" xlink:href=\"#abc\" xml:space=\"preserve\" /></svg>", out: "<>\n  <svg viewBox=\"0 0 10 10\">\n    <path stroke-width=\"2\" xlink:href=\"#abc\" xml:space=\"preserve\" />\n  </svg>\n</>" },

  // Text escaping
  { desc: "text escaping braces", in: "<div>Hello {world}</div>", out: "<>\n  <div>\n    Hello {\"{\"}world{\"}\"}\n  </div>\n</>" },
  { desc: "text multiline formatting", in: "<div>\n  A\n  B\n</div>", out: "<>\n  <div>\n    \n  A\n  B\n\n  </div>\n</>" },

  // Raw text elements
  { desc: "script tags raw", in: "<script>const a = `{${b}}`;</script>", out: "<>\n  <script>\n    {`const a = \\`{\\${b}}\\`;`}\n  </script>\n</>", diags: [{"code":"jsx.raw-element-warning","severity":"warning","message":"<script> block found, emitting as template literal","offset":8,"line":1,"column":9,"end":27}] },
  { desc: "style tags raw", in: "<style>.a { color: red; }</style>", out: "<>\n  <style>\n    {`.a { color: red; }`}\n  </style>\n</>", diags: [{"code":"jsx.raw-element-warning","severity":"warning","message":"<style> block found, emitting as template literal","offset":7,"line":1,"column":8,"end":25}] },

  // Incomplete markup / Errors
  { desc: "unclosed element at EOF", in: "<div><span>a", out: "<>\n  <div>\n    <span>\n      a\n    </span>\n  </div>\n</>", diags: [{"code":"jsx.unclosed-element","severity":"warning","message":"<div> was never closed; it is closed at end of input","data":{"tag":"div"},"offset":0,"line":1,"column":1,"end":5},{"code":"jsx.unclosed-element","severity":"warning","message":"<span> was never closed; it is closed at end of input","data":{"tag":"span"},"offset":5,"line":1,"column":6,"end":11}] },
  { desc: "unclosed element before end tag", in: "<div><span>a</div>", out: "<>\n  <div>\n    <span>\n      a\n    </span>\n  </div>\n</>", diags: [{"code":"jsx.unclosed-element","severity":"warning","message":"<span> was never closed; it is closed by </div>","data":{"tag":"span","closedBy":"div"},"offset":5,"line":1,"column":6,"end":11}] },
  { desc: "stray end tag", in: "<div></div></span>", out: "<>\n  <div />\n</>", diags: [{"code":"jsx.stray-end-tag","severity":"warning","message":"</span> has no open <span>; it is dropped","data":{"tag":"span"},"offset":11,"line":1,"column":12,"end":18}] },
  { desc: "void element end tag", in: "<img src=\"a.png\"></img>", out: "<>\n  <img src=\"a.png\" />\n</>", diags: [{"code":"jsx.void-end-tag","severity":"warning","message":"</img> is a void element and never has an end tag; it is dropped","data":{"tag":"img"},"offset":17,"line":1,"column":18,"end":23}] },
  { desc: "unclosed element nested deeply", in: "<div><ul><li><p>abc", out: "<>\n  <div>\n    <ul>\n      <li>\n        <p>\n          abc\n        </p>\n      </li>\n    </ul>\n  </div>\n</>", diags: [{"code":"jsx.unclosed-element","severity":"warning","message":"<div> was never closed; it is closed at end of input","data":{"tag":"div"},"offset":0,"line":1,"column":1,"end":5},{"code":"jsx.unclosed-element","severity":"warning","message":"<ul> was never closed; it is closed at end of input","data":{"tag":"ul"},"offset":5,"line":1,"column":6,"end":9},{"code":"jsx.unclosed-element","severity":"warning","message":"<li> was never closed; it is closed at end of input","data":{"tag":"li"},"offset":9,"line":1,"column":10,"end":13},{"code":"jsx.unclosed-element","severity":"warning","message":"<p> was never closed; it is closed at end of input","data":{"tag":"p"},"offset":13,"line":1,"column":14,"end":16}] },
  { desc: "another error case", in: "<a><b></b></c>", out: "<>\n  <a>\n    <b />\n  </a>\n</>", diags: [{"code":"jsx.unclosed-element","severity":"warning","message":"<a> was never closed; it is closed at end of input","data":{"tag":"a"},"offset":0,"line":1,"column":1,"end":3},{"code":"jsx.stray-end-tag","severity":"warning","message":"</c> has no open <c>; it is dropped","data":{"tag":"c"},"offset":10,"line":1,"column":11,"end":14}] },

  // Edge cases
  { desc: "empty tag", in: " ", error: "jsx.empty" },
  { desc: "invalid identifier component name", in: "<div></div>", opts: { wrap: "component", "component-name": "123-invalid" }, error: "jsx.invalid-option" },
  { desc: "empty value attribute", in: "<div class=\"\"></div>", out: "<>\n  <div className=\"\" />\n</>" },
  { desc: "quote types in output", in: "<div class='a' id=\"b\" data-x='c\"d'></div>", out: "<>\n  <div className='a' id=\"b\" data-x='c\"d' />\n</>" },
  { desc: "quote types in output 2", in: "<div data-y=c\"d></div>", out: "<>\n  <div data-y={\"c\\\"d\"} />\n</>" },
  { desc: "data and aria attributes", in: "<div data-foo=\"bar\" aria-label=\"baz\"></div>", out: "<>\n  <div data-foo=\"bar\" aria-label=\"baz\" />\n</>" },
  
  // Mixed tests
  { desc: "mixed html and svg", in: "<div><svg><path d=\"M0\" /></svg></div>", out: "<>\n  <div>\n    <svg>\n      <path d=\"M0\" />\n    </svg>\n  </div>\n</>" },
  { desc: "complex nested structure", in: "<ul><li>1</li><li>2</li></ul>", out: "<>\n  <ul>\n    <li>\n      1\n    </li>\n    <li>\n      2\n    </li>\n  </ul>\n</>" },
  { desc: "bogus comments", in: "<?xml version=\"1.0\"?><!DOCTYPE html><html></html>", out: "<>\n  <html />\n</>" },
  { desc: "text with spaces", in: "<span>  hello  </span>", out: "<>\n  <span>\n      hello  \n  </span>\n</>" },
];

let counter = 1000;
for (const test of TESTS) {
  counter++;
  const id = `DU-24-${crypto.createHash("md5").update(test.desc).digest("hex").slice(0, 8)}`;
  
  const fixture = {
    id,
    operationId: OPERATION,
    options: test.opts || {},
    input: {
      "input": test.in
    }
  };
  
  if (test.error) {
    fixture.error = test.error;
  } else {
    fixture.output = {
      "output": test.out
    };
    if (test.diags) {
      fixture.diagnostics = test.diags;
    } else {
      fixture.diagnostics = [];
    }
  }
  
  fs.writeFileSync(`plugins/jsx/fixtures/${id}.json`, JSON.stringify(fixture, null, 2));
}

console.log("Fixtures generated.");
