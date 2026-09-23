# Manual test plan

For a human tester driving the Windows desktop app by hand. Automated suites
(`pnpm test`, `test:ui`, `scripts/native-suite.mjs`) already cover the code
paths; this plan covers what only a person can judge — real dialogs, real
files, real clipboards, real displays, and whether the result on screen is the
*right* result.

About forty of the cases below now run unattended against the built executable:
`node scripts/native-suite.mjs` uses these ids, so anything it covers needs your
attention only when it fails. The ids it owns are marked **(suite)**.

Read [DEVUTILS_REQUIREMENTS.md](DEVUTILS_REQUIREMENTS.md) for what each tool is
supposed to do; the screenshots it references are the parity reference when a
case says "compare against the card".

## How to use this plan

- Work through a section at a time. Each case has an ID; record **pass**,
  **fail**, **blocked** or **n/a** against that ID.
- A case passes only if every sentence under *Expected* is true. Partial is a
  fail with a note.
- Cases marked **[P1]** are release blockers. Unmarked cases are defects worth
  filing but not blockers.
- Where a case says *record*, write the observed value down even when it
  passes — those numbers are the baseline for the next pass.
- If the app misbehaves in a way no case describes, that is still a bug. This
  list is a floor, not a ceiling.

### Bug report template

```text
Case:        RES-14
Build:       <git sha from the title bar / the commit you built>
Environment: Windows 11 26200, 150% scale, 2560x1440
Steps:       1. … 2. … 3. …
Expected:    …
Actual:      …
Evidence:    screenshot path, saved input file, result file
Severity:    blocker / major / minor / cosmetic
```

**Severity:** *blocker* = data loss, wrong output presented as correct, crash,
or the app cannot start. *major* = a tool or flow is unusable, no workaround.
*minor* = works with a workaround. *cosmetic* = layout, wording, spacing.

### Vocabulary

- **Engine** — where a tool runs. **Rust** tools are compiled into the app;
  **package** tools run in a webview worker. The status bar says *Local engine*
  either way; the split matters only when a case asks you to compare them.
- **Tool id** — the dotted name (`text.case`), used in bug reports.
- **Auto tools** re-run about a third of a second after you stop typing.
  **Explicit tools** only run when you press their operation button.

---

## 0. Before you start

### 0.1 Build and launch

```bash
pnpm --dir apps/desktop install
```

```bash
pnpm --dir apps/desktop tauri dev
```

For a packaging-faithful pass (required at least once per release):

```bash
pnpm --dir apps/desktop tauri build --debug --no-bundle
```

then run `target\debug\devtools-desktop.exe`. `tauri dev` loads the UI from a
dev server and cannot reproduce a packaging fault — see
[UI_REGRESSION_BASELINE.md](UI_REGRESSION_BASELINE.md).

### 0.2 Environment matrix

Run sections 1–6 and 12 in every row; sections 7–11 in row A only unless a case
says otherwise.

| Row | Display | Scale | Window |
|---|---|---|---|
| A | 1920×1080 or larger | 100% | maximised |
| B | 1366×768 | 150% | maximised |
| C | ultrawide (3440×1440) | 100% | maximised |
| D | any | 100% | restored to ~900×650, then ~640×520 |

Also record: Windows build, WebView2 runtime version
(`Get-AppxPackage *WebView2*` or Settings → Apps), GPU, and whether the machine
is on battery.

### 0.3 Test data

Generate the fixture set once, into a folder whose path contains a space and a
non-ASCII character (e.g. `C:\test data\ünicode\`):

```bash
node -e "const fs=require('fs'),p=process.argv[1];fs.mkdirSync(p,{recursive:true});const w=(n,s)=>fs.writeFileSync(p+'/'+n,s);w('small.json',JSON.stringify({store:{book:[{category:'reference',title:'Sample',price:8.95}]}},null,2));w('invalid.json','{\"a\": }');w('crlf.txt','line one\r\nline two\r\nline three\r\n');w('lf.txt','line one\nline two\nline three\n');w('bom.txt','\ufeffwith a byte order mark\n');w('astral.txt','emoji 👩‍🚀 accents éàü CJK 日本語 RTL مرحبا\n');w('long-line.txt','x'.repeat(2000000));w('big.json',JSON.stringify(Array.from({length:120000},(_,i)=>({i,name:'row '+i,tags:['a','b']}))));w('huge.txt','lorem ipsum dolor sit amet\n'.repeat(4000000));w('sample.md','# Title\n\nSome **bold** text, a [link](https://example.com) and:\n\n- one\n- two\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n');w('sample.html','<!doctype html><html><head><title>t</title></head><body><div class=\"a\"><p>Hello <b>world</b></p><!-- note --></div></body></html>');w('sample.css','.a{color:red;background:#fff}  .b , .c{margin:0 auto;padding:1px 2px}/* note */');w('sample.js','function f(a,b){if(a){return [1,2].map(x=>x*b)}else{throw new Error(`no ${a}`)}}');w('sample.sql','select a.id, b.name from users a join orders b on b.user_id=a.id where a.active=1 order by b.name');w('sample.xml','<?xml version=\"1.0\"?><root><item id=\"1\"><name>a</name></item><empty/></root>');w('sample.yaml','store:\n  book:\n    - title: Sample\n      price: 8.95\n  open: true\n');w('curl.txt','curl -X POST https://api.example.com/v1/items -H \"Content-Type: application/json\" -d \"{\\\"a\\\":1}\"');w('binary.bin',Buffer.from(Array.from({length:4096},(_,i)=>i%256)));console.log('written to',p)" "C:\test data\ünicode"
```

Also needed:
- `benchmarks/fixtures/clipboard-roundtrip.png` (already in the repo).
- A **read-only** copy of `small.json` (Properties → Read-only).
- A file on a **removable drive or network share** if you have one.
- Two JWTs signed HS256 with the secret `test-secret`, valid until 2036 and
  already expired. Mint your own (never paste a real token into a test):

```bash
node -e "const c=require('crypto'),b=o=>Buffer.from(JSON.stringify(o)).toString('base64url'),s='test-secret',n=Math.floor(Date.now()/1000),mk=p=>{const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),y=b(p);return h+'.'+y+'.'+c.createHmac('sha256',s).update(h+'.'+y).digest('base64url')};console.log('valid  ',mk({sub:'1234567890',name:'Test User',iat:n,exp:n+315360000}));console.log('expired',mk({sub:'1234567890',name:'Test User',iat:n-7200,exp:n-3600}))"
```

### 0.4 Ground rules for every case

- **The app must never modify your input file.** Before any case that opens a
  file, record its SHA-256 (`certutil -hashfile <path> SHA256`); after the
  case, check it again. A changed hash is a blocker, always.
- **No network.** The app is local-only. If you can watch traffic (Fiddler,
  Wireshark, or Resource Monitor's network tab), confirm it stays silent
  except for WebView2's own startup.
- Take a screenshot of anything you are about to report.

---

## 1. Smoke — the app starts and works at all

| ID | Steps | Expected |
|---|---|---|
| SMK-01 (suite) **[P1]** | Launch the app | A window titled *The DevTools Pro · Native preview* opens within 10 s, dark theme, tool rail on the left, tab bar and workspace on the right. Nothing renders as an unstyled document |
| SMK-02 (suite) **[P1]** | Look at the status bar | The engine dot is lit and reads *Local engine* (not *Browser preview*); the status text reads *Ready* |
| SMK-03 (suite) **[P1]** | Count the tools in the rail | Every group renders with a heading; record the total. CI's native smoke currently reports **32**. A number materially lower means package discovery failed |
| SMK-04 **[P1]** | Press Ctrl+N, type `hello` | A tab appears, the editor accepts text, the status bar shows *Ln 1, Col 6* |
| SMK-05 **[P1]** | Choose **JSON**, paste `{"b":1,"a":[1,2]}`, press **Format** | The result pane shows indented JSON and the state line reports success |
| SMK-06 **[P1]** | Choose **String Case Converter**, type `userID_loaderHTTPServer v2Api`, set Target to `snake` | Result is `user_id_loader_http_server_v_2_api` (this is the value CI asserts) |
| SMK-07 | Open the command palette (Ctrl+K) | The dialog opens, focus is in the search field, commands are listed |
| SMK-08 **[P1]** | Close the window | The app exits within 3 s; no process named `devtools-desktop.exe` or orphaned `msedgewebview2.exe` remains (check Task Manager) |
| SMK-09 | Relaunch | The app starts clean; no crash dialog, no "restore" prompt unless the product claims one |

If any P1 here fails, stop and report — the rest of the plan is not meaningful.

---

## 2. Documents, tabs and files

| ID | Steps | Expected |
|---|---|---|
| DOC-01 | Ctrl+N three times | Three tabs, each independently selectable; the active one is visually distinct |
| DOC-02 | Give each tab a different tool and different text; switch between them | Each tab keeps its own text, tool, options and result. Nothing bleeds across tabs |
| DOC-03 (suite) **[P1]** | Open `small.json` with **Open file** | A new tab opens named after the file; the document info shows the file name, its size and kind; the text is the file's content |
| DOC-04 (suite) **[P1]** | Repeat DOC-03, then check the file's hash | The file on disk is byte-identical to before |
| DOC-05 | Open the same file twice | Either a second tab opens or the existing tab activates — whichever happens, no tab shows stale or duplicated content |
| DOC-06 | Open `astral.txt` | Emoji, accents, CJK and RTL text render correctly, not as boxes or mojibake |
| DOC-07 | Open `bom.txt` | The BOM does not appear as a visible character at the start of the text; the encoding indicator still reads UTF-8 |
| DOC-08 | Open `crlf.txt`, then `lf.txt` | Both show three lines. Line endings are not doubled or shown as `^M` |
| DOC-09 **[P1]** | Open `crlf.txt`, run any formatter, **Save result** to a new file, open it in a hex viewer | Line endings are consistent and intentional (all CRLF or all LF); no mixed `\r\r\n` |
| DOC-10 | Open `binary.bin` | The app refuses gracefully with a readable message, or shows a binary/preview mode. It must not paste 4 KB of garbage into the editor and must not hang |
| DOC-11 **[P1]** | Type in a tab, then press Ctrl+W | The *Save your changes?* dialog appears with Cancel / Discard / Save… |
| DOC-12 **[P1]** | In that dialog press **Cancel** | The tab stays open with its text intact |
| DOC-13 **[P1]** | Press Ctrl+W again, then **Discard** | The tab closes; no file was written |
| DOC-14 **[P1]** | Press Ctrl+W on another dirty tab, then **Save…** | An untitled tab opens the Windows save dialog; saving writes the file and closes the tab, and cancelling the dialog leaves it open. A tab opened from a file is written back to that file and closes |
| DOC-15 | Close a clean (unmodified) tab | It closes with no prompt |
| DOC-16 | Close the last remaining tab | The app shows the empty state (*A place for your next idea*) and stays usable |
| DOC-17 (suite) **[P1]** | Open a file, edit it, press Ctrl+S | No dialog: the file is written back in place, and the button reads **Save**. Reopening it shows the saved text |
| DOC-18 | Ctrl+Shift+S (**Save as**), pick an existing file, then **cancel** Windows' *replace?* prompt | Nothing is written; the original file's hash is unchanged. Confirming instead replaces it |
| DOC-19 | Save into the folder with the space and non-ASCII name | The file is written; its name and path are correct in Explorer |
| DOC-20 (suite) | Open a **read-only** file, edit it, press Ctrl+S | *Not saved: … read-only …* in the status line. The file is unchanged, and the edits (and any result) stay, still marked unsaved |
| DOC-21 | Open a file, delete it in Explorer, then Ctrl+S | Refused: *moved or deleted … Use Save As*. The edits stay; Ctrl+Shift+S saves them |
| DOC-22 | Open a file from a removable drive, remove the drive, then Ctrl+S | Readable error; no hang longer than ~10 s |
| DOC-23 | Open 10 tabs | The tab strip scrolls or condenses; every tab remains reachable and closable |
| DOC-24 | With many tabs open, close one in the middle | Focus moves to a sensible neighbour, not to a random tab or nothing |
| DOC-25 | Open a 200+ MB file (`huge.txt` is ~100 MB — double it) | Either it opens with a preview notice or it is refused with a clear limit message within ~20 s. It must not freeze the UI indefinitely |
| DOC-26 | Drag a file from Explorer onto the window | A new tab opens with that file |
| DOC-27 **[P1]** | Type in a tab so it is dirty, then drag a file onto the window | The dirty tab is **not** replaced; the dropped file opens in its own tab |
| DOC-28 | Drag several files at once | Either all open as tabs or only the first does, with no error dialog spam and no lost tabs |
| DOC-29 | Drag a folder onto the window | Graceful refusal; no crash |
| DOC-30 (suite) **[P1]** | Open a file, change it in Notepad and save there, then edit it in the app and press Ctrl+S | Refused: *changed on disk after it was opened … Use Save As*. Notepad's version is untouched. Ctrl+Shift+S, confirming the replace, overwrites it deliberately |
| DOC-31 (suite) | New tab, type, Ctrl+S, pick a path; edit, Ctrl+S again | The first save asks; the second writes to the same file without asking |
| DOC-30 | Drag a file over the window and drag it back out without dropping | The drop highlight appears and then clears; no tab is created |

---

## 3. Editor and input

| ID | Steps | Expected |
|---|---|---|
| EDT-01 | Type a few lines; move the caret | *Ln x, Col y* in the status bar tracks the caret, counting from 1 |
| EDT-02 | Select text with the mouse, with Shift+arrows, and with Ctrl+A | Selection behaves like a normal text box |
| EDT-03 **[P1]** | Type, then Ctrl+Z several times, then Ctrl+Y | Undo steps back through your edits; redo replays them. The result pane follows the restored text |
| EDT-04 | Undo past the beginning, redo past the end | Nothing breaks; no exception, no cleared document |
| EDT-05 | Paste 2 MB of text (`long-line.txt`) | The editor accepts it within a couple of seconds. If a preview notice appears, it says tools still process all bytes |
| EDT-06 **[P1]** | With a large pasted input, run a tool | The tool processes the **whole** input, not the preview. Verify with a length-reporting tool (Text inspector) |
| EDT-07 | Copy text elsewhere, press the **Clipboard** quick action | The clipboard text is inserted at the caret / replaces the selection |
| EDT-08 | Press **Clipboard** with an empty clipboard, and with an image on the clipboard | A readable message; no crash |
| EDT-09 | Press **Sample** on JSON, URL, HTML, Find & Replace, Base64-to-image | Each inserts a sensible sample for that tool and the result updates |
| EDT-10 | Press **Clear** | The editor empties; the result pane clears or shows the empty state — it must not keep showing the previous result as current |
| EDT-11 | Type into a very long single line (no newlines) | The editor stays responsive; horizontal behaviour (wrap or scroll) is consistent |
| EDT-12 | Scroll to the middle of a long document, switch tabs, switch back | The scroll position and caret are preserved |
| EDT-13 | Type continuously for ~10 s in an auto tool | No dropped characters, no caret jumps, no mid-typing result flicker that steals focus |
| EDT-14 (suite) **[P1]** | Type into an auto tool and stop | The result refreshes on its own within ~1 s (debounce is ~350 ms) |
| EDT-15 (suite) | Type into an explicit tool (CSS, XML) | The result does **not** appear until you press an operation button. JSON is a bundled Rust tool and runs as you type by design — that is not a failure of this case; any stale result is visibly marked stale rather than presented as current |
| EDT-16 | Paste text containing a NUL byte or lone surrogate | Either sanitised or refused with a message; never a crash or a truncated-without-warning document |
| EDT-17 | Open the image tool (**Image to Base64**) and open a PNG | The image renders in the input area as a picture, not as bytes |
| EDT-18 | In an image tool, try to type in the input area | Typing is blocked or ignored cleanly; the app does not corrupt the image |
| EDT-19 | Switch a tab from a text tool to an image tool and back | The text is not lost when returning to the text tool (or the loss is explicit and warned) |
| EDT-20 | In **Diff & Compare**, put text only on the left | The footer explains that the right side is empty rather than showing a red error |
| EDT-21 | In Diff & Compare, open a file into each side with the **Open file…** buttons | Each side loads independently; neither file is modified |
| EDT-22 | In Diff & Compare, use Ctrl+Z inside the left editor | Undo applies to that editor |
| EDT-23 | Resize the window narrow (row D) while typing | The editor stays usable; no controls fall off the edge or overlap |
| EDT-24 | Drag the splitter between document and result; then use it with the keyboard (focus it, arrows, Home, End) | The panes resize smoothly, arrows nudge, Home ≈ 28% and End ≈ 72%; the layout never collapses to zero width |
| EDT-25 | Zoom the OS display scale from 100% to 150% while the app is open | The layout reflows; text stays crisp and nothing is clipped |

---

## 4. Finding and switching tools

| ID | Steps | Expected |
|---|---|---|
| NAV-01 | Read the rail top to bottom | Tools are grouped under headings; every entry has a name and an icon; no entry is blank or `undefined` |
| NAV-02 (suite) | Type `json` in the search box | Matching tools remain, others hide. Clearing restores the full list |
| NAV-03 | Search for a name that does not exist | An empty list or an explicit "no matches" state — not a broken rail |
| NAV-04 | Search by a word from a tool's description or alias (e.g. `svg`, `qr`, `timestamp`) | Sensible matches appear. Record any tool you cannot find by an obvious word |
| NAV-05 | Collapse the sidebar with the collapse button | The rail collapses, the workspace widens, the button's label flips to expand |
| NAV-06 | Expand it again | The rail returns with the same scroll position |
| NAV-07 | Select a tool for the active tab | The tool header (icon, group eyebrow, title) and the window's title area update; the options shown are that tool's options |
| NAV-08 (suite) **[P1]** | Switch tools within one tab, keeping the same text | The text is preserved; the previous tool's result is cleared or marked stale — never shown as the new tool's output |
| NAV-09 | Ctrl+K, type part of a tool name, press Enter | The first match runs: that tab switches to the tool |
| NAV-10 | Ctrl+K, navigate with ↓/↑, press Enter | Selection moves; Enter applies the highlighted command |
| NAV-11 | Ctrl+K, press Escape | The dialog closes and focus returns to where it was |
| NAV-12 | Ctrl+K with three tabs open | Tool commands are listed per tab (`Tool · tab name`), and choosing one switches to that tab |
| NAV-13 | Open the palette, type a query matching nothing | An empty list; Enter does nothing harmful |
| NAV-14 | Use only the keyboard to reach and select a tool from the rail | Tab/arrow navigation reaches rail entries; Enter or Space selects |
| NAV-15 | Select a generator (**UUID**, **Unix Timestamp**, **Example String**) on an empty tab | It runs without any input and produces output — these tools must not demand text first |

---

## 5. Options and execution

| ID | Steps | Expected |
|---|---|---|
| OPT-01 (suite) **[P1]** | For each tool, read its options against the table in section 8 | Every declared option is present, labelled in words (not raw ids), with its documented default preselected |
| OPT-02 | Change an enum option (e.g. Indentation) | The result re-runs (auto tools) or the button re-runs with the new value (explicit tools); the output visibly reflects the change |
| OPT-03 | Toggle a boolean option | Same as OPT-02, in both directions |
| OPT-04 | Type into a string option (Regex pattern, Find query, Component name) | The value is used; leading/trailing spaces are preserved unless the tool documents trimming |
| OPT-05 | Type into an integer option (Cell size, Context lines, Count) | Accepts values in range; out-of-range values are rejected or clamped with a message, never silently producing nonsense |
| OPT-06 | Enter a non-numeric value in an integer option | Rejected with a readable message; no crash, no `NaN` in the output |
| OPT-07 **[P1]** | JWT: type a secret into the **Key** field | The field masks the value (password-style). It must not be readable on screen or in a screenshot |
| OPT-08 | Change options, switch to another tab and back | The options you set are still there |
| OPT-09 | Change options, switch tool away and back | Options reset to defaults or restore your values — either is acceptable, but it must be consistent and never a mix of the two |
| OPT-10 | Open two tabs with the same tool and different options | The two tabs do not share option values |
| OPT-11 **[P1]** | Run a multi-operation tool (JSON: Format / Minify / Validate; CSS, XML, SQL, JS: Beautify / Minify) | Each operation button appears exactly once, and each produces its own distinct result |
| OPT-12 | Press an operation button twice quickly | The second run supersedes the first; you never see two results interleaved or a stuck progress bar |
| OPT-13 | Start a slow run (format `big.json`) and watch the status bar | The progress panel appears with a phase and a progress bar; it disappears when the run finishes |
| OPT-14 **[P1]** | During a slow run press **Cancel** | The run stops within ~2 s, the status says so, and no partial result is presented as complete |
| OPT-15 **[P1]** | Cancel a run, then run again | The second run completes normally — cancellation must not wedge the engine |
| OPT-16 | Start a slow run in tab 1, switch to tab 2 and run a fast tool | Both behave independently; tab 2's result is not attributed to tab 1 |
| OPT-17 | Start a slow run and immediately edit the input | Either the run is superseded by a new one or the finished result is marked stale. A result from stale input must never be shown as current |
| OPT-18 | Start a slow run and switch tools mid-run | No orphaned progress bar; no result from the old tool under the new tool's header |
| OPT-19 | Trigger a tool's deadline (feed `huge.txt` to a 1–2 s deadline tool such as Text Diff or Base64 Text) | A timeout message, not a hang. Record the wall time |
| OPT-20 | Feed input larger than a tool's documented limit (see section 8) | A limit message naming the limit; no crash, no truncated output presented as complete |

---

## 6. Results, renderers and result actions

| ID | Steps | Expected |
|---|---|---|
| RES-01 **[P1]** | Run any successful operation | The result state line says it succeeded, and the output area shows the output |
| RES-02 (suite) **[P1]** | Run an operation that fails (invalid JSON) | A clear error naming *what* is wrong and *where* (line/column where applicable). The output area stays empty — no blank "success" |
| RES-03 (suite) | After a failure, fix the input and re-run | The error clears completely; no stale error text remains beside the good result |
| RES-04 | Look at the metrics row after a run | Metrics (sizes, counts, durations) are plausible and labelled. Record anything that is always zero |
| RES-05 | Expand **Operation details** | Structured detail about the run is shown; it is readable, not raw JSON with escaped quotes |
| RES-06 **[P1]** | Press **Copy complete result**, paste into Notepad | The **entire** result is pasted, not the visible preview. Compare lengths for a large result |
| RES-07 **[P1]** | With a large (truncated) result, click in the output, Ctrl+A, Ctrl+C, paste | You get the complete result, not the truncated preview |
| RES-08 (suite) **[P1]** | Press **Save result**, accept the suggested name | The file saves with a sensible extension for the type (`.json`, `.html`, `.css`, `.js`, `.xml`, `.yaml`, `.sql`, `.md`, `.svg`, `.txt`) and opens correctly in its native app |
| RES-09 (suite) | Save a result over an existing file and confirm the overwrite | The file is replaced; cancelling the prompt leaves it untouched. A result can never be saved over a file open in a tab, including its own source |
| RES-10 (suite) **[P1]** | Press **Open result** | The result opens as the input of a tab, so you can chain tools. The original tab keeps its own content |
| RES-11 | Chain three tools with Open result (e.g. YAML→JSON, then JSON Format, then Hash) | Each step receives the previous step's complete output |
| RES-12 (suite) | Press **Hide result**, then **Show result** | The result pane collapses and returns, with the result intact |
| RES-13 | Collapse the result with the ›/‹ button in the pane header | Same behaviour; the button's tooltip flips |
| RES-14 (suite) | Run a tool whose output is JSON (**JSON Format**, **URL Parser**, **YAML to JSON**) and press **Tree** | The result is walkable: expandable nodes with type and size, and each row's path can be copied |
| RES-14b | In Tree view type `$..price`, then `$.store.book[0]`, then a filter like `$.a[?(@.b==1)]` | The first two report a match count and list the matches with their paths; the filter is **refused by name** ("Filter expressions are not supported") rather than showing an empty list, which would read as "nothing matched" |
| RES-15 **[P1]** | Run **Markdown Preview** on `sample.md` | The preview renders as a formatted document (heading, bold, list, code block) inside the result pane |
| RES-16 **[P1]** | In the Markdown/HTML preview, click the `https://example.com` link | Nothing navigates the app away; at most it opens your browser. The app window must never become a web page |
| RES-17 **[P1]** | Preview HTML containing `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` | No alert dialog appears. Record whether the content is stripped or just inert |
| RES-18 | Preview HTML referencing a remote image (`<img src="https://example.com/x.png">`) | The preview does not fetch it (watch the network) or the failure is silent — either way, no console errors that break the pane |
| RES-19 **[P1]** | Run **QR Code** on `https://example.com` | An actual QR image renders in the result. Scan it with a phone: it resolves to `https://example.com` |
| RES-20 | Save the QR result | The saved `.svg` opens in a browser and shows the same code with its white quiet-zone border intact |
| RES-21 (suite) **[P1]** | Run **Regular Expression Tester** with pattern `\d{4}` on text containing years | Matches are highlighted **in the input editor** at the right positions, and listed in the result |
| RES-22 | With the regex tool, scroll the input | The highlights stay aligned with the text as it scrolls |
| RES-23 | Change the regex so nothing matches | Highlights clear; the result says zero matches rather than showing the last run's matches |
| RES-24 **[P1]** | Run **Image to Base64** on the PNG, then **Base64 to Image** on the result | The round trip reproduces the same image; the decoded preview shows a picture, not bytes |
| RES-25 | Run **Diff & Compare** on two similar texts | Differences are presented as readable hunks with line context; identical texts report "no differences" plainly |
| RES-26 | Make the result pane very narrow, then very wide | Content reflows; no horizontal scrollbar hiding content permanently; no overlap |
| RES-27 | Produce a result of several MB (format `big.json`) | The pane stays responsive; scrolling the output does not freeze the UI for more than ~1 s |
| RES-28 | Produce a result larger than the result limit | A message naming the limit appears. Copy/Save either work on the complete payload or are clearly disabled |
| RES-29 | Run a tool that produces no output for empty input | A neutral empty state, not a success claim and not an error, unless the tool documents empty as an error (QR does) |
| RES-30 | Switch tabs while a result is displayed | Each tab shows its own result immediately; no flash of another tab's result |
| RES-31 (suite) | Run **CSS → Beautify**, then edit the CSS without pressing anything. Also: change an option instead of editing; and cancel a long run | The old result stays, labelled **Out of date — run to update**, never "Updating…" when nothing is running. Copy and Save are hidden until it is run again |

---

## 7. The standard battery

Run this battery against **every tool** in section 8. It is the same twelve
checks each time — record a pass/fail per tool per check in the matrix.

| # | Check |
|---|---|
| TB-01 | The tool appears in the rail, is findable by search, and its header shows a real name and group |
| TB-02 | Its documented operations all appear, once each |
| TB-03 | Its documented options all appear with documented defaults |
| TB-04 | The happy-path input from section 8 produces the expected output |
| TB-05 | Every option value changes the output in the documented way (walk each enum value, both boolean states, range ends of integers) |
| TB-06 | Empty input is handled per section 8 (neutral empty state, or the documented error) |
| TB-07 | Whitespace-only input does not crash and does not claim a false success |
| TB-08 | Input with emoji, accents, CJK and RTL survives unchanged where the tool is not supposed to alter it |
| TB-09 | CRLF input does not produce mixed or doubled line endings |
| TB-10 | The documented error case produces a readable message and an empty output |
| TB-11 | Oversized input produces the documented limit message |
| TB-12 | Copy complete result, Save result and Open result all work for this tool |

**Coverage matrix** — copy this and fill it in:

```text
tool                 TB-01 02 03 04 05 06 07 08 09 10 11 12
structured.json        .   .  .  .  .  .  .  .  .  .  .  .
text.case              .   .  .  .  .  .  .  .  .  .  .  .
…
```

---

## 8. Per-tool cases

Options listed here are what the tool declares; TB-03 checks them against the
UI. *Limit* is the declared maximum input; *deadline* is the declared time
budget for one run.

### TL-JSON — JSON · `structured.json` · Rust · STRUCTURED DATA
Operations: Format, Minify, Validate. No options. Limit 64 MiB, deadline 5 s.

| # | Input | Action | Expected |
|---|---|---|---|
| 01 (suite) | `{"b":1,"a":[1,2]}` | Format | Indented, keys in source order unless a sort option exists |
| 02 | same | Minify | `{"b":1,"a":[1,2]}` with no spaces |
| 03 | same | Validate | Reports valid, with structure details |
| 04 | `{"a": }` | Format | Error naming line and column; empty output |
| 05 | `{"a":1,"a":2}` | Validate | Duplicate key is reported or the winner is stated — record which |
| 06 (suite) | `1e400`, `1.7976931348623157e308`, `123456789012345678901234567890` | Format | Large numbers are preserved exactly, not rounded to `Infinity` or `1.2345678901234568e+29` |
| 07 | `{"s":"\u00e9\ud83d\ude00","esc":"\/"}` | Format | Escapes and astral characters survive a round trip |
| 08 | `big.json` | Format | Completes; record the time |
| 09 | `[]`, `{}`, `null`, `"str"`, `42` | Validate | Each is accepted as valid JSON |
| 10 | file with BOM | Format | Accepted or a clear error; not a silent wrong parse |

### TL-CSV — CSV inspector · `structured.csv` · Rust
| # | Input | Expected |
|---|---|---|
| 01 (suite) | `a,b\n1,2\n3,4` | Row and column counts correct |
| 02 | Quoted field with an embedded comma and newline | Parsed as one field |
| 03 | Ragged rows (3 columns then 2) | Reported, not silently padded |
| 04 | Semicolon-delimited data | Either detected or reported as one column — record the behaviour |

### TL-INSPECT — Text inspector · `text.inspect` · Rust · **known parity gap**
| # | Input | Expected |
|---|---|---|
| 01 (suite) | `Hello ✓` | Character count 7, byte count 9 (UTF-8), one line |
| 02 | `astral.txt` | Counts distinguish code points from UTF-16 units; the emoji with a ZWJ is counted consistently and the rule is stated |
| 03 | `crlf.txt` | Line count 3 regardless of CRLF |
| 04 | — | Compare every reported field against the DU-22 screenshot; list what is missing. This tool is known to be unaudited for parity |

### TL-CASE — String Case Converter · `text.case` · package · auto
Options: target (camel, pascal, snake, kebab, screaming-kebab, constant), acronyms (`ID,API,DB,URL,HTTP`), preserve-acronyms. Limit 1 MiB.

| # | Input | Action | Expected |
|---|---|---|---|
| 01 (suite) | `userID_loaderHTTPServer v2Api` | snake | `user_id_loader_http_server_v_2_api` |
| 02 | same | camel / pascal / kebab / screaming-kebab / constant | Each target produces its own convention consistently |
| 03 | `my URL parser` | preserve-acronyms on vs off | `URL` is kept as a unit when on |
| 04 | custom acronym list `AWS,GCP` with `myAWSBucket` | snake | `AWS` treated as an acronym |
| 05 | `déjà vu` | snake | Accents preserved, not stripped |
| 06 (suite) | `   ` | any | Neutral empty result |

### TL-TIME — Unix Timestamp Converter · `time.unix` · package · generator
Options: interpretation (auto, seconds, milliseconds, iso), milliseconds-from-digits (1–20, default 12). Limit 4 KiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | empty | Runs with no input and shows the current time |
| 02 (suite) | `1700000000` | Interpreted as seconds → 14 Nov 2023 UTC; local time also shown |
| 03 | `1700000000000` | Interpreted as milliseconds (auto, by digit count) |
| 04 | `2023-11-14T22:13:20Z` | Parsed as ISO and converted back to epoch |
| 05 | `0`, `-1`, `2147483648` | Epoch, pre-epoch and post-2038 all handled |
| 06 (suite) | `abc` | Readable error |
| 07 | — | Compare the displayed time zone handling with the DU-01 card |

### TL-UUID — UUID Generator · `identity.uuid` · package · generator
Operations: **Generate** (version v1/v3/v4/v5, namespace, name, count 1–100, case) and **Decode** (case; the UUID is whatever is in the editor).

| # | Steps | Expected |
|---|---|---|
| 01 (suite) | Generate, v4, count 1 | A syntactically valid v4 UUID; version nibble is `4` |
| 02 (suite) | Generate, count 100 | 100 UUIDs, all distinct |
| 03 | Run v4 generation twice | Different values each time (not seeded/repeating) |
| 04 (suite) | v5 with namespace `dns`, name `example.com` | Stable across runs and equal to `cfbff0d1-9375-5685-968c-48ce8b15ae17` (RFC 4122; computed independently of this app). v3 of the same pair is also stable across runs |
| 05 | v1 | Time-based, values increase across successive runs |
| 06 | case upper/lower | Output case follows the option |
| 07 | Put a v1 UUID in the editor and press **Decode** | Timestamp, variant and version reported |
| 08 | Press **Decode** with `not-a-uuid` in the editor | Readable error |
| 09 (suite) **[P1]** | With **Generate** selected, type anything in the editor; then press **Generate** | Typing does nothing: the generated value stays, with no error, no "Updating…", and Copy still works. The press gives a new value |
| 10 (suite) | Put the v5 value from 04 in the editor and press **Decode**; then replace it with `f47ac10b-58cc-4372-a567-0e02b2c3d479` | Version 5 reported; after the edit it decodes again on its own and reports version 4 |

### TL-B64TEXT — Base64 Text · `encoding.base64-text` · package · auto
Options: mode (encode, decode), variant (standard, url), padding (required, omit, optional), error-policy (strict, tolerant, replace). Limit 2 MiB.

| # | Input | Options | Expected |
|---|---|---|---|
| 01 (suite) | `hello` | encode | `aGVsbG8=` |
| 02 (suite) | `aGVsbG8=` | decode | `hello` |
| 03 | `~~~?>>` | encode, variant url | Uses `-` and `_`, never `+` or `/` |
| 04 (suite) | `aGVsbG8` (no padding) | decode, padding required | Error; with padding optional, decodes |
| 05 | `aGVsbG8=!!` | decode, strict vs tolerant | Strict errors; tolerant/replace documents what it does |
| 06 | `👩‍🚀` | encode then decode | Round trip is byte-identical |
| 07 | 2 MiB text | encode | Completes or reports the limit |

### TL-URL — URL Encode / Decode · `text.url` · Rust
| # | Input | Options | Expected |
|---|---|---|---|
| 01 (suite) | `https://example.com/search?q=hello world` | encode | Space becomes `%20` |
| 02 (suite) | same | encode, form encoding (if offered) | Space becomes `+` |
| 03 | `%E2%9C%93` | decode | `✓` |
| 04 (suite) | `%ZZ` | decode | Readable error, not a silent pass-through |
| 05 | `a+b` | decode in both modes | Record the difference between rfc3986 and form |

### TL-URLPARSE — URL Parser · `web.url-parser` · package · auto
Option: indent (0–8, default 2). Limit 1 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `https://user:pw@example.com:8443/a/b?x=1&y=two&x=3#frag` | Scheme, credentials, host, port, path, query pairs (including the repeated `x`) and fragment all listed |
| 02 (suite) | same | The tree view is readable and the indent option changes the code view |
| 03 | `not a url` | Readable error |
| 04 | `https://例え.jp/パス` | IDN host and percent-decoded path shown correctly |
| 05 | query with `a=%20%2B&b=` | Decoded values shown, empty value preserved |

### TL-HTMLESC — HTML Escape / Unescape · `text.html` · Rust
| # | Input | Action | Expected |
|---|---|---|---|
| 01 (suite) | `<p class="sample">Hello & bye</p>` | escape | `&lt;p class=&quot;sample&quot;&gt;…&amp;…` |
| 02 (suite) | `&lt;b&gt;&amp;amp;` | unescape | `<b>&amp;` |
| 03 | `&#x2713;` and `&#10003;` | unescape | Both give `✓` |
| 04 | `&nosuchentity;` | unescape | Left as-is or flagged; not silently deleted |
| 05 | `✓👩‍🚀` | escape then unescape | Round trip identical |

### TL-JSONSTR — JSON String Escape / Unescape · `text.json-string` · Rust
| # | Input | Action | Expected |
|---|---|---|---|
| 01 (suite) | `{"name":"Sample","items":[1,2,3]}` | escape | Quotes escaped, result is a valid JSON string literal |
| 02 | result of 01 | unescape | Back to the original, byte-identical |
| 03 | text with a tab, newline and backslash | escape | `\t`, `\n`, `\\` |
| 04 | `"\u00e9"` | unescape | `é` |

### TL-BACKSLASH — Backslash Escape / Unescape · `text.backslash` · package · auto
Options: mode, quotes (both, double, single, none), non-ascii (keep, unicode, utf16).

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `a"b'c\d` with quotes=both | Both quote styles escaped |
| 02 | same with quotes=none | Neither escaped |
| 03 | `é` with non-ascii=unicode vs utf16 | `\u00e9` vs the UTF-16 form; keep leaves it alone |
| 04 | `\n\t` literal text | escape then unescape round-trips |

### TL-UNICODE — Unicode Escape / Unescape · `text.unicode` · Rust
| # | Input | Action | Expected |
|---|---|---|---|
| 01 | `Hello ✓` | escape | `Hello \u2713` |
| 02 | `\u2713` | unescape | `✓` |
| 03 | `👩‍🚀` | escape | Surrogate pair or code point form — consistent and reversible |
| 04 | `\uZZZZ` | unescape | Readable error |

### TL-HASH — Hash Generator · `encoding.hash` · Rust (MD5/SHA-1/224/384 only in the package build)
Option: case. Limit 64 MiB, deadline 10 s.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `hello` | SHA-256 `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`; cross-check with `certutil -hashfile` on a file containing exactly `hello` with no trailing newline |
| 02 | `hello` | MD5 `5d41402abc4b2a76b9719d911017c592` if MD5 is offered. **Record which algorithms the UI actually exposes** — the Rust path historically shows only SHA-256/512 |
| 03 | empty input | SHA-256 of empty is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 04 | the PNG fixture | Matches `certutil -hashfile <png> SHA256` |
| 05 | case option upper | Hex digits uppercase, same value |
| 06 | 64 MiB file | Completes within the deadline or reports the limit; record the time |

### TL-BASE64IMG — Image to Base64 / Base64 to Image · `encoding.image-base64`, `encoding.base64-image` · Rust
| # | Steps | Expected |
|---|---|---|
| 01 (suite) | Encode the PNG fixture | Base64 (or data URI) produced; the input shows the image |
| 02 | Copy complete result → decode it | The same image comes back; visually identical |
| 03 | Decode an invalid Base64 string | Readable error, no broken-image placeholder claiming success |
| 04 | Decode a data URI with the wrong MIME | Either honoured or reported; not a silent mismatch |
| 05 | Encode a JPEG and a large PNG (>5 MB) | Works or reports a limit |
| 06 | Save the decoded image | The saved `.png` opens in Photos and matches the original byte-for-byte where the format allows |

### TL-FIND — Find & Replace · `text.find-replace` · Rust · explicit
Options: query, replacement, mode (find, replace, replaceAll), case-sensitive, whole-word.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `Sample text\nReplace this text`, query `text` | Find reports 2 matches with positions |
| 02 | query `TEXT`, case-sensitive on / off | 0 matches vs 2 |
| 03 | whole-word on with query `ext` | 0 matches |
| 04 | replace `text`→`word`, mode replace vs replaceAll | First-only vs all |
| 05 | empty query | Neutral: no matches, no crash, no "replaced everything" |
| 06 | query with regex metacharacters `a.b` | Treated literally (this is not the regex tool) |

### TL-REGEX — Regular Expression Tester · `text.regex` · package · auto
Options: pattern, mode (match, replace), replacement, global, ignore-case, multiline, dot-all, unicode, sticky. Limit 4 MiB, deadline 2 s.

| # | Input / pattern | Expected |
|---|---|---|
| 01 (suite) | text `2024-02-29 and 1999-12-31`, pattern `(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})` | Two matches; named groups `y`,`m`,`d` and numbered groups both listed; highlights on both dates |
| 02 | global off | Only the first match |
| 03 | ignore-case with `HELLO` against `hello` | Match only when the flag is on |
| 04 | multiline with `^line` against a 3-line text | Matches each line start only when on |
| 05 | dot-all with `a.b` across a newline | Matches only when on |
| 06 | sticky | Documented behaviour from index 0 |
| 07 | mode replace, pattern `o`, replacement `0` on `hello world` | `hell0 w0rld`, replacement count 2 |
| 08 | replacement using `$1` and `$$` | Group substitution and a literal `$` |
| 09 | invalid pattern `(` | Readable error, no crash, no hang |
| 10 | catastrophic pattern `(a+)+b` against 30 `a`s | Either fast or stopped by the 2 s deadline — the UI must stay responsive |
| 11 | pattern matching 20,000+ times in a big text | Match list is capped with an explicit "showing N of M" style note; the count stays exact |
| 12 | zero-length match pattern `a*` | Does not loop forever |

### TL-JWT — JWT Decoder & Verifier · `security.jwt` · package · auto
Options: key (**masked**), secret-encoding (utf8, base64, base64url), clock-tolerance-seconds. Limit 64 KiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | A valid HS256 token, no key | Header and payload decoded and readable; signature reported as unverified |
| 02 | Same token with the correct secret | Signature reported valid |
| 03 | Wrong secret | Signature reported invalid — clearly, not a subtle field |
| 04 | Expired token (`exp` in the past) | Expiry called out; clock-tolerance option shifts the verdict |
| 05 | Token with `alg: none` | Not treated as verified |
| 06 | Malformed token (two segments) | Readable error |
| 07 | Token with a base64 secret and secret-encoding=base64 | Verifies; with utf8 it does not |
| 08 **[P1]** | Take a screenshot with the key filled in | The secret is masked in the screenshot |

### TL-YAML — YAML ↔ JSON · `convert.yaml` · package · auto
Operations: YAML to JSON, JSON to YAML. Options: indent, sort-keys (YAML→JSON). Limit 16 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.yaml` → JSON | Correct nesting, types preserved (`8.95` number, `true` boolean) |
| 02 | That JSON → YAML | Round trip reproduces the original structure |
| 03 | sort-keys on | Keys ordered alphabetically |
| 04 | indent space2 / space4 / minified | Output shape follows the option |
| 05 | YAML with an anchor/alias (`&a`, `*a`) | Documented error (`yaml.alias-unsupported`), readable in the UI |
| 06 | YAML with a duplicate key | Documented error, not a silent last-wins |
| 07 | YAML with bad indentation | Error names the line |
| 08 (suite) | YAML `.inf`, `.nan`, `~`, `null` | Handled per the README; record what each becomes |
| 09 | JSON with a very deep nesting (200 levels) | Either converts or reports a depth limit; no stack crash |

### TL-XML — XML · `format.xml` · package · explicit
Operations: Beautify, Minify. Options: indent (sp2, sp4, tab), preserve-comments, collapse-empty. Limit 16 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.xml` | Beautify indents the tree; the declaration is preserved |
| 02 | same | Minify removes insignificant whitespace only |
| 03 | preserve-comments off | `<!-- -->` removed; on, kept |
| 04 | collapse-empty on/off | `<empty/>` vs `<empty></empty>` |
| 05 | CDATA and processing instructions | Preserved verbatim |
| 06 | Unclosed tag | Readable error naming the position |
| 07 | Attributes with single vs double quotes and entities | Preserved or normalised consistently |

### TL-HTMLFMT — HTML Beautify/Minify · `format.html` · package
Options: indent, preserve-comments, wrap-attributes (auto, force), indent-inner-html. Limit 16 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.html` | Beautify produces readable indented markup |
| 02 | same | Minify collapses whitespace but does not break `<pre>` or `<textarea>` content |
| 03 | inline `<script>` and `<style>` | Content is not mangled |
| 04 | wrap-attributes force on a tag with many attributes | One attribute per line |
| 05 | Malformed HTML (`<div><p></div>`) | Best-effort output or a clear message — never silently dropped content |

### TL-CSS — CSS · `format.css` · package · explicit
Options: indent (sp2, sp4, tab), preserve-comments, blank-line-between-rules. Limit 16 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.css` | Beautify: one declaration per line, normalised selector spacing |
| 02 | same | Minify: no spaces around `{`, `:`, `;`; last `;` optional but consistent |
| 03 | preserve-comments off/on | `/* note */` dropped / kept |
| 04 | blank-line-between-rules on/off | Blank line between rules appears/disappears |
| 05 | `@media`, `@supports`, nested rules | Nesting preserved and indented |
| 06 | `url("data:image/png;base64,…")` with braces inside | Not broken by the tokenizer |
| 07 | Unclosed brace | Readable error |

### TL-JS — JavaScript Formatter · `format.js` · package
Options (beautify): indent (space-2, space-4, tab), brace-style, preserve-newlines, max-preserve-newlines (0–10), space-in-parens, end-with-newline. Minify: preserve-comments (none, license). Limit 8 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.js` | Beautify produces conventionally formatted JS |
| 02 | brace-style collapse / expand / end-expand | Brace placement follows the option |
| 03 | max-preserve-newlines 0 vs 10 | Blank-line runs collapse or survive |
| 04 | Minify with `/*! license */` and `// note` | License comment kept (preserve-comments=license), others dropped; with `none`, all dropped |
| 05 **[P1]** | Minify `a = b / c / d; x = /b[/]c/g; s = "/*";` | Division stays division, the regex literal survives, the string is untouched |
| 06 **[P1]** | Minify `function f(){ return\nvalue }` and `y\n++z` | The newlines that ASI depends on are preserved |
| 07 | Nested template literals `` `a${`b${c}`}` `` | Preserved exactly |
| 08 (suite) | Minify then Beautify (chain with Open result) | Semantically the same code; record any difference |
| 09 | Unterminated string / template / comment | Documented error, readable |

### TL-SQL — SQL Formatter · `format.sql` · package
Options: dialect (sql, mysql, mariadb, postgresql, plsql), keyword-case, indent, comma-position. Limit 4 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.sql` | Beautify: clauses on their own lines, joins readable |
| 02 | keyword-case upper / lower / preserve | `SELECT` vs `select` vs as written |
| 03 | comma-position end / start | Commas trail / lead |
| 04 | dialect postgresql with `::text` cast and `$$` block | Not mangled |
| 05 (suite) | mysql backtick identifiers | Preserved |
| 06 | A string containing `--` or `/*` | Not treated as a comment |
| 07 | Minify | Single-line statement that still runs |

### TL-JSX — HTML/SVG to JSX · `convert.jsx` · package · auto
Options: wrap (none, fragment, component), component-name, indent, svg-attributes (camel, keep). Limit 4 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.html` | `class` → `className`, `<!-- -->` → `{/* */}`, self-closing tags valid JSX |
| 02 | wrap none / fragment / component | Bare markup, `<>…</>`, or a named component using component-name |
| 03 | An SVG with `stroke-width`, `xlink:href` | camel → `strokeWidth`; keep leaves as written |
| 04 | `style="color:red;font-size:12px"` | Converted to a style object |
| 05 (suite) | Inline `<script>` or `<style>` | Handled or explicitly reported |
| 06 | Malformed markup | Readable error |

### TL-PREVIEW — Markdown & HTML Preview · `preview.documents` · package · auto
Operations: Preview Markdown, Preview HTML. Markdown options: gfm, breaks, theme (light, dark). Limit 4 MiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `sample.md` | Heading, bold, link, list and fenced code all render correctly |
| 02 | GFM table and task list, gfm on/off | Rendered as a table / as literal text |
| 03 | breaks on/off | Single newlines become `<br>` or not |
| 04 | theme light/dark | The preview's own background and text change |
| 05 **[P1]** | Markdown containing `<script>alert(1)</script>` and `[x](javascript:alert(1))` | No alert; the javascript: link does not execute |
| 06 | `sample.html` with Preview HTML | Renders as a page |
| 07 | Very long document (2 MB of markdown) | Renders or reports the limit; UI stays responsive |
| 08 (suite) | Switch to the code representation | The generated HTML source is available and copyable |

### TL-QR — QR Code · `media.qr` · package · auto
Options: error-correction (L, M, Q, H), cell-size (1–40), margin (0–16), version (0–40). Input limit 2953 bytes.

| # | Input | Expected |
|---|---|---|
| 01 **[P1]** | `https://example.com` | A scannable QR; a phone resolves it to that URL |
| 02 | Same at error-correction L, M, Q, H | All scannable; the module count grows with the level |
| 03 | cell-size 1 and 40 | Image size changes; at 40 it is large but still correct |
| 04 | margin 0 and 16 | The white quiet zone disappears / grows. At margin 0 a scanner may fail — that is expected, but the border must visibly change |
| 05 (suite) | version 1 with a long input | Documented capacity error |
| 06 | version 40 with `hello` | Large, sparse, still scannable |
| 07 | 2953 bytes at level L | Encodes; 2954 bytes is a capacity error |
| 08 | Empty input | Documented `qr.empty` error |
| 09 | `日本語のテキスト` | Encodes as bytes; scanning returns the same text |
| 10 | Save the SVG and open it in a browser | Identical rendering; `width`/`height` match the viewBox scale |

### TL-DIFF — Diff & Compare · `text.compare` · Rust · two inputs
Options: newline (preserve, lf, crlf, ignore), context-lines (0–64).

| # | Input | Expected |
|---|---|---|
| 01 (suite) | Two texts differing in one line | The changed line is shown with context |
| 02 | Identical texts | "No differences" stated plainly |
| 03 | context-lines 0 vs 10 | Surrounding context shrinks/grows |
| 04 | One side CRLF, other LF, newline=ignore vs preserve | Ignore reports no difference; preserve reports every line changed |
| 05 (suite) | `big.json` on each side, one side edited | Completes; record the time |
| 06 | Left empty, right filled | The footer explains the empty side; no red error |
| 07 | Files opened into both sides | Neither file is modified (check hashes) |

### TL-NUMBASE — Number Base Converter · `number.base` · package · auto
Options: from-base (2–36), to-base (2–36), digits (lower, upper). Limit 64 KiB.

| # | Input | Expected |
|---|---|---|
| 01 (suite) | `255`, 10 → 16 | `ff` (lower) / `FF` (upper) |
| 02 | `ff`, 16 → 2 | `11111111` |
| 03 | `zz`, 36 → 10 | `1295` |
| 04 | Very long number (200 digits) | Exact, no floating-point rounding |
| 05 (suite) | `2`, from-base 2 | Readable error (invalid digit for the base) |
| 06 | Negative and `+` prefixed values | Documented behaviour |
| 07 | from-base 1 or 37 | Rejected by the control's range |

### TL-EXAMPLES — Example String Generator · `generate.examples` · package · generator
Options: category (paragraph, sentence, word, title, first-name, last-name, full-name, email, url, short-tweet, long-tweet), count (1–100).

| # | Steps | Expected |
|---|---|---|
| 01 (suite) | Each category once | Output matches the category (an email looks like an email, a URL like a URL) |
| 02 | count 1 vs 100 | Exactly that many items |
| 03 | Run the same category twice | Variety across runs (or documented determinism) |
| 04 | With no input document | Works — this is a generator |

### TL-CURL — cURL to Code · `web.curl-code` · Rust
| # | Input | Expected |
|---|---|---|
| 01 (suite) | `curl.txt` | JavaScript fetch output is valid JS with method, URL, headers and body |
| 02 | same | Python requests output is valid Python with the same semantics |
| 03 | `curl` with `-u user:pass` and cookies | Credentials appear in the generated code (and are not silently dropped) |
| 04 | Multiline `curl` with `\` continuations | Parsed as one command |
| 05 (suite) | Not a curl command | Readable error |

### TL-EDITOR — Text editor · `editor.text`
| # | Steps | Expected |
|---|---|---|
| 01 (suite) | Select the editor tool | Single-pane layout, no result pane demanded |
| 02 | Type, save, reopen | Content round-trips |

---

## 9. Limits, performance and cancellation

| ID | Steps | Expected |
|---|---|---|
| PERF-01 | Time app launch to usable rail, cold and warm | Record both. Cold should be under ~10 s |
| PERF-02 | Open `big.json` (≈6 MB) | Opens within ~10 s; typing afterwards stays responsive |
| PERF-03 | Format `big.json` | Completes or reports a limit; record the time. The UI never stops repainting for more than ~1 s at a stretch |
| PERF-04 | Hash a 64 MiB file | Completes within the 10 s deadline or reports the limit |
| PERF-05 **[P1]** | Start the slowest run you found, press Cancel | Stops within ~2 s; memory returns to roughly the pre-run level within a minute (Task Manager) |
| PERF-06 | Run 10 operations in a row in one tab | No creeping memory growth of hundreds of MB; record before/after |
| PERF-07 | Leave the app open with 10 tabs for an hour, then use it | Still responsive; no runaway CPU while idle (should be ~0%) |
| PERF-08 | Watch CPU while typing in an auto tool | No sustained 100% of a core; the debounce means one run per pause |
| PERF-09 | Feed `huge.txt` (100 MB) to a 1 MiB-limit tool (String Case) | Immediate, clear limit message — not a 100 MB processing attempt |
| PERF-10 | Resize the window continuously for 10 s | No flicker storm, no layout corruption |
| PERF-11 | Run a tool, then immediately close the tab | No error dialog; no orphaned progress |
| PERF-12 | Close the app while a long run is in flight | Exits cleanly within a few seconds |

---

## 10. Robustness and awkward input

| ID | Input / action | Expected |
|---|---|---|
| ROB-01 | Paste 10 MB into an auto tool with a 1 MiB limit | One clear limit message, not one per keystroke |
| ROB-02 | Hold a key down for 5 s in an auto tool | Stays responsive; one run after you stop |
| ROB-03 | Click an operation button 20 times rapidly | One result; no queue of stale runs |
| ROB-04 | Switch tools 20 times rapidly | No stuck spinner, no mismatched header/result |
| ROB-05 | Open and close 20 tabs rapidly | No leak of tab state; the rail and tab bar stay correct |
| ROB-06 | Input of only spaces / only newlines | Handled per TB-07 |
| ROB-07 | Input with mixed line endings (`\r\n` and `\n` in one file) | Tools do not corrupt it; diff reports it if asked |
| ROB-08 | Input with a lone `\r` | Not treated as a line break inconsistently between the editor and the tools |
| ROB-09 | Text with 100,000 short lines | Editor and tools cope; record timing |
| ROB-10 | One line of 2,000,000 characters (`long-line.txt`) | No freeze longer than a few seconds |
| ROB-11 | Deeply nested JSON/YAML/XML (200+ levels) | Depth limit reported rather than a crash |
| ROB-12 | Input that is valid UTF-8 but semantically wrong for the tool (JSON into the SQL formatter) | Readable error or best-effort output; never a crash |
| ROB-13 | Paste HTML from Word/Outlook (rich text on the clipboard) | Plain text is inserted; no hidden markup corrupting the tool |
| ROB-14 | Use the app while another instance is running | Both work; saving in one does not corrupt the other's file |
| ROB-15 | Lock the workstation mid-run, unlock | The run completed or is cancellable; nothing is wedged |
| ROB-16 | Sleep/resume the machine with the app open | The app recovers; the engine dot still reads *Local engine* |
| ROB-17 | Change the OS display scale while a run is in flight | No crash; layout reflows afterwards |
| ROB-18 | Disconnect the network entirely | Every tool still works — nothing depends on the internet |
| ROB-19 | Run with a restricted (non-admin) user account | No permission prompts; the app works |
| ROB-20 | Move the app window between monitors with different DPI | Layout adjusts within a second; no blurry or clipped UI |

---

## 11. Safety, privacy and data integrity

| ID | Check | Expected |
|---|---|---|
| SEC-01 **[P1]** | Hash every input file before and after a full session | No input file is ever modified |
| SEC-02 **[P1]** | Watch network traffic through a whole session | No outbound request carries document content. Record anything you see |
| SEC-03 **[P1]** | JWT key field, and any option marked sensitive | Masked on screen; not written into a saved result or a visible log |
| SEC-04 | Save a result, then inspect the file | Contains exactly the result, no injected metadata or stray BOM unless documented |
| SEC-05 | Look for temp files during a large operation (`%TEMP%`) | Anything written there is cleaned up afterwards; nothing holds document content after exit |
| SEC-06 **[P1]** | Preview a malicious HTML/Markdown document (script, iframe, form posting to a remote host, `javascript:` links) | Nothing executes and nothing is sent |
| SEC-07 | Open a file, close the tab, check whether the content survives anywhere visible in the UI | No leftover content in another tab or in the palette |
| SEC-08 | Confirm the app does not require sign-in, telemetry consent or a network call to start | It starts fully offline |

---

## 12. Accessibility, display and input devices

| ID | Check | Expected |
|---|---|---|
| A11Y-01 **[P1]** | Complete a whole task (open file → choose tool → set an option → run → copy result) using **only** the keyboard | Possible without a mouse; focus is always visible |
| A11Y-02 | Tab through the whole window | Focus order is logical; no trap; the palette and dialogs return focus on close |
| A11Y-03 | Check focus rings on dark backgrounds | Visible on every control |
| A11Y-04 | Use Windows Narrator on the rail, tabs, editor, options and result | Controls announce meaningful names, not "button" |
| A11Y-05 | Check the progress/status region with Narrator | Status changes (running, completed, failed) are announced |
| A11Y-06 | Windows high-contrast mode | The app remains legible; no invisible text |
| A11Y-07 | Text scaling at 125%/150% (Windows setting) | No clipped labels or overlapping controls |
| A11Y-08 | Row D small window (640×520) | Every control is reachable, possibly via scrolling; nothing is unreachable |
| A11Y-09 | Ultrawide (row C) | The layout does not stretch controls absurdly; the result pane stays usable |
| A11Y-10 | Colour check on the result state line | Success/failure is distinguishable without relying on colour alone (icon or words) |
| A11Y-11 | Mouse wheel and trackpad scrolling in editor, result and rail | All scroll smoothly; the wheel does not zoom accidentally |
| A11Y-12 | Touch screen (if available) | Taps, scrolling and the splitter behave |
| A11Y-13 | Right-click in the editor and in the result | A sensible context menu (cut/copy/paste/select all) or none — but never a broken browser menu with Reload/Inspect |
| A11Y-14 | Double-click and triple-click in the editor | Word and line selection behave |
| A11Y-15 | Check the window at 100% with Windows dark and light themes | The app's dark theme is intentional and consistent in both |

---

## 13. Lifecycle and persistence

| ID | Check | Expected |
|---|---|---|
| LIF-01 | Set options and tabs, close the app, reopen | Document the actual behaviour (fresh start vs restored session). Either is acceptable if consistent; silent loss of unsaved work without a prompt is not |
| LIF-02 **[P1]** | Close the app with unsaved changes | You are prompted before anything is lost |
| LIF-03 | Kill the process from Task Manager, reopen | No corrupt state; the app starts clean |
| LIF-04 | Delete the app's profile/config folder, start again | Starts with defaults; no crash |
| LIF-05 | Run the packaged build (`tauri build --debug --no-bundle`) through sections 1 and 7 | Behaves the same as the dev build. Any difference is a packaging bug |
| LIF-06 | Move the executable to another folder and run it | Still works (no hard-coded paths) |
| LIF-07 | Run on a machine without the WebView2 runtime, if you can find one | A clear message or an automatic install — not a blank window |

---

## 14. Regression watchlist

Defects fixed during development. Re-check each release; a failure here means
a fix was lost.

| ID | Origin | Check |
|---|---|---|
| REG-01 | Sensitive options rendered in the clear | JWT key is masked (TL-JWT-08) |
| REG-02 | SVG results routed through the binary path | QR result renders as an image and Copy/Save work (TL-QR-01, RES-20) |
| REG-03 | Preview frame blocked by the content policy | Markdown/HTML preview renders content, not an empty frame (RES-15) |
| REG-04 | Editor highlights misaligned after scrolling | Regex highlights track the text (RES-22) |
| REG-05 | QR quiet zone measured in pixels instead of cells | Margin 0 vs 16 visibly changes the border (TL-QR-04) |
| REG-06 | JS minifier broke ASI and regex literals | TL-JS-05 and TL-JS-06 |
| REG-07 | Truncated preview copied instead of the full result | RES-06 and RES-07 |
| REG-08 | Window built before the webview was ready | The app opens with content, never a white or black empty window (SMK-01) |
| REG-09 | Stale result shown after switching tools | NAV-08 |
| REG-10 | Dirty tab replaced by a dropped file | DOC-27 |
| REG-11 | CRLF handling differed between Windows and CI | DOC-08, DOC-09, TB-09 |
| REG-12 | Hash algorithms available in the package but not the UI | TL-HASH-02 — record exactly which algorithms the UI offers |
| REG-13 (suite) | Options were taken from the first operation, so an option declared on a later one was unreachable | JavaScript Formatter: Beautify does not offer *Preserve comments* and Minify does |
| REG-14 (suite) | The same option id with different choices per operation: the UI offered a value the operation rejects | JSON to YAML offers only `space2`/`space4`, and choosing the last one runs cleanly |

---

## 15. Exit criteria

A build is ready to ship when:

1. Every **[P1]** case passes on environment row A, and on rows B–D for
   sections 1–6 and 12.
2. No open blocker or major defect without an agreed workaround.
3. The standard battery (section 7) has been run against every tool, with the
   matrix filled in.
4. Section 11 passes in full — no input file altered, no network traffic, no
   secret displayed.
5. The packaged build (LIF-05), not just `tauri dev`, was used for at least
   sections 1, 7 and 11.
6. Every failure has a filed report with the template in *How to use this
   plan*, and every *record* value is written down for the next pass.
