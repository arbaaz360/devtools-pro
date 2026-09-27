import { test, expect } from './native-mock.mjs';

// The release UI conventions (docs/RELEASE_UI_SPEC.md) as a person sees them: names,
// groups, chrome copy, which buttons exist, what the result pane says. Package tools run
// on the real worker engine; the mock host serves the native ids it lists.

const GROUP_ORDER = ['WORKSPACE', 'FORMAT', 'CONVERT', 'ENCODE', 'TEXT', 'WEB & SECURITY', 'GENERATE'];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function chooseTool(page, name) {
  await page.locator('.tool-item').filter({ has: page.locator('strong', { hasText: new RegExp(`^${escape(name)}$`) }) }).click();
}
async function newText(page, text) {
  await page.keyboard.press('Control+n');
  await expect(page.locator('#preview')).toBeFocused();
  if (text !== undefined) await page.locator('#preview').fill(text);
}
async function completed(page) {
  await expect(page.locator('#result-state')).toContainText('Completed successfully');
  await expect(page.locator('#result-state')).not.toContainText('Updating');
}
const tabNames = (page) => page.locator('#tabs .tab-name').allTextContents();

test('chrome: a wordmark and a Commands button, one privacy statement, and a ready status', async ({ page, host }) => {
  void host;
  await expect(page.locator('.topbar')).not.toContainText('⌘');
  await expect(page.locator('.brand')).toHaveText('DevTools Pro');
  await expect(page.locator('#palette-open')).toHaveText(/^\s*Commands\s*Ctrl K\s*$/);
  await expect(page.locator('.local-pill')).toHaveText('Local only');
  const all = await page.evaluate(() => document.body.textContent);
  for (const slogan of ['Files stay on your computer', 'Editable documents · Local processing', 'Separate result', 'Processed locally', 'Each tab keeps its own tool and result'])
    expect(all, slogan).not.toContain(slogan);
  await expect(page.locator('#engine-status')).toHaveText('Local');
  await expect(page.locator('#status')).toHaveText('Ready · Ctrl+N for a new document');
  await expect(page.locator('#empty-state h3')).toHaveText('No document open');
  await expect(page.locator('#empty-state p').first()).toHaveText('Create a document or open a file, then choose a tool.');
  await expect(page.locator('.app-title')).toHaveText('DevTools Pro');
  await newText(page);
  await expect(page.locator('#status')).toHaveText('Ready');
  await expect(page.locator('.app-title')).toHaveText('Text Editor');
  await page.keyboard.press('Control+w');
  await expect(page.locator('#status')).toHaveText('Ready · Ctrl+N for a new document');
});

test('the rail: fixed group order, names sorted in each group, a glyph and a description for every tool', async ({ page, host }) => {
  void host;
  const groups = await page.locator('.tool-group').evaluateAll((sections) => sections.map((section) => ({
    label: section.querySelector('.group-label').textContent,
    tools: [...section.querySelectorAll('.tool-item')].map((item) => ({
      name: item.querySelector('strong').textContent,
      icon: item.querySelector('.tool-item-icon').textContent,
      description: item.querySelector('small').textContent,
    })),
  })));
  // The mock host's renderer probes sit in their own group, after the fixed ones.
  expect(groups.map((group) => group.label)).toEqual([...GROUP_ORDER, 'MOCKS']);
  for (const group of groups) {
    const names = group.tools.map((tool) => tool.name);
    expect(names, group.label).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  }
  const tools = groups.flatMap((group) => group.tools).filter((tool) => !tool.name.endsWith('(mock)'));
  const icons = tools.map((tool) => tool.icon);
  expect(new Set(icons).size, icons.join(' ')).toBe(icons.length);
  for (const tool of tools) {
    expect(tool.icon, tool.name).not.toBe('◇');
    expect(tool.description.trim(), tool.name).not.toBe('');
  }
  expect(groups[0].tools.map((tool) => tool.name)).toEqual(['Text Editor']);
  const where = (name) => groups.find((group) => group.tools.some((tool) => tool.name === name))?.label;
  expect(where('JSON Formatter')).toBe('FORMAT');
  expect(where('cURL to Code')).toBe('CONVERT');
  expect(where('Hash Generator') ?? 'ENCODE').toBe('ENCODE');
  expect(where('Text Inspector')).toBe('TEXT');
  expect(where('Text Diff')).toBe('TEXT');
  expect(where('JWT Decoder & Verifier')).toBe('WEB & SECURITY');
  expect(where('QR Code Reader')).toBe('GENERATE');
});

test('the tool header and the rail say what the tool does', async ({ page, host }) => {
  void host;
  await newText(page, 'hello');
  await chooseTool(page, 'Base64 Text');
  await expect(page.locator('#active-tool-label')).toHaveText('ENCODE');
  await expect(page.locator('#active-tool-title')).toHaveText('Base64 Text');
  await expect(page.locator('#active-tool-subtitle')).toHaveText('Encode text as Base64, or decode Base64 to text');
  await chooseTool(page, 'JSON Formatter');
  await expect(page.locator('#active-tool-subtitle')).toHaveText('Format, minify or validate JSON');
  await expect(page.locator('.tool-item.active small')).toHaveText('Format, minify or validate JSON');
});

test('tab names count per tool, and the top bar names the active document', async ({ page, host }) => {
  void host;
  await newText(page);
  await chooseTool(page, 'UUID Generator');
  await newText(page);
  expect(await tabNames(page)).toEqual(['UUID Generator', 'Text Editor']);
  await chooseTool(page, 'UUID Generator');
  expect(await tabNames(page)).toEqual(['UUID Generator', 'UUID Generator 2']);
  await expect(page.locator('.app-title')).toHaveText('UUID Generator 2');
  await page.locator('.tab-close').first().click();
  expect(await tabNames(page)).toEqual(['UUID Generator']);
  await expect(page.locator('.app-title')).toHaveText('UUID Generator');
});

test('the palette lists document commands, each open tab, and each tool once', async ({ page, host }) => {
  void host;
  await newText(page, 'first');
  await newText(page, 'second');
  await chooseTool(page, 'Base64 Text');
  const rail = await page.locator('.tool-item strong').allTextContents();
  await page.keyboard.press('Control+k');
  const commands = await page.locator('#command-list button').allTextContents();
  expect(commands.slice(0, 4)).toEqual(['New document', 'Open file', 'Save', 'Save as…']);
  expect(commands.slice(4, 6)).toEqual(['Switch to Text Editor', 'Switch to Base64 Text']);
  expect(commands.slice(6)).toEqual(rail);
  expect(new Set(commands).size).toBe(commands.length);
  // A tool applies to the active tab; it neither opens a tab nor picks another one.
  await page.locator('#palette-search').fill('String Case');
  await page.keyboard.press('Enter');
  await expect(page.locator('#active-tool-title')).toHaveText('String Case Converter');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#preview')).toHaveValue('second');
  await page.keyboard.press('Control+k');
  await page.locator('#palette-search').fill('Switch to Text');
  await page.keyboard.press('Enter');
  await expect(page.locator('#preview')).toHaveValue('first');
});

test('QR Code Reader is an image tool because its manifest says so', async ({ page, host }) => {
  // With nothing open, choosing it asks for an image rather than opening a text tab.
  const dialogs = () => host.calls.filter((call) => call.cmd === 'plugin:dialog|open').length;
  const before = dialogs();
  await chooseTool(page, 'QR Code Reader');
  await expect.poll(dialogs).toBe(before + 1);
  await expect(page.getByRole('tab')).toHaveCount(0);

  await newText(page, 'some text');
  await chooseTool(page, 'QR Code Reader');
  await expect(page.locator('#preview')).toBeHidden();
  await expect(page.locator('#input-message-text')).toHaveText('This tab does not contain an image. Open a PNG or JPEG image to use QR Code Reader.');
  await expect(page.locator('#input-open-compatible')).toBeVisible();
  await expect(page.locator('.input-quick-actions')).toBeHidden();
  await expect(page.locator('.toolbar-actions button')).toHaveText(['Read']);
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();

  // The image it asks for opens in QR Code Reader, where Read can start.
  host.openPaths.push('image.png');
  await page.locator('#input-open-compatible').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#active-tool-title')).toHaveText('QR Code Reader');
  await expect(page.locator('#input-image')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toBeEnabled();
});

test('operation buttons show only where they choose or start something', async ({ page, host }) => {
  void host;
  await newText(page, 'b\na\n');
  await chooseTool(page, 'Line Tools');
  await completed(page);
  await expect(page.locator('.toolbar-actions button')).toHaveCount(0);
  await expect(page.locator('#result-subtitle')).toHaveText('Updates as you type');
  await chooseTool(page, 'Text Inspector');
  await completed(page);
  await expect(page.locator('.toolbar-actions button')).toHaveCount(0);
  await chooseTool(page, 'CSS Formatter');
  await expect(page.locator('.toolbar-actions button')).toHaveText(['Format', 'Minify']);
  await page.getByRole('button', { name: 'Format', exact: true }).click();
  await completed(page);
  await expect(page.locator('#result-subtitle')).toHaveText('Press Format or Minify to run');
  await chooseTool(page, 'QR Code Reader');
  await expect(page.locator('.toolbar-actions button')).toHaveText(['Read']);
});

test('options the current mode ignores are hidden: Hex decode has no case, separator or width', async ({ page, host }) => {
  void host;
  await newText(page, 'hi');
  await chooseTool(page, 'Hex ↔ Text');
  const labels = () => page.locator('.format-control label').evaluateAll((nodes) => nodes.map((node) => node.querySelector('select, input')?.getAttribute('aria-label')));
  await expect.poll(labels).toEqual(['Mode', 'Case', 'Separator', 'Bytes per line']);
  await page.getByLabel('Mode').selectOption('decode');
  await expect.poll(labels).toEqual(['Mode']);
  await page.getByLabel('Mode').selectOption('encode');
  await expect.poll(labels).toEqual(['Mode', 'Case', 'Separator', 'Bytes per line']);
});

test('an inspection lists its findings in the output area', async ({ page, host }) => {
  void host;
  await newText(page, 'one\ntwo\nthree\nfour');
  await chooseTool(page, 'Text Inspector');
  await completed(page);
  const rows = await page.locator('#result-structured .summary-row').evaluateAll((items) =>
    items.map((row) => `${row.querySelector('dt')?.textContent}: ${row.querySelector('dd').textContent}`));
  expect(rows).toContain('lines: 4');
  await expect(page.locator('#result-structured')).toBeVisible();
  await expect(page.locator('#result-status-message')).toBeHidden();
  await expect(page.locator('#results-heading')).toBeVisible();
  // No output document, so no Out in the one metrics line.
  await expect(page.locator('#result-metrics')).toHaveText(/^In 18 B · \d+ ms$/);
});

test('a tool gated by validation shows the reason as its result, never a stale one', async ({ page, host }) => {
  void host;
  await newText(page, 'curl https://example.com/a');
  await chooseTool(page, 'cURL to Code');
  await completed(page);
  await expect(page.locator('#result-output')).toHaveValue('await fetch("https://example.com/a");');
  await page.locator('#preview').fill('hello');
  await expect(page.locator('#result-state')).toHaveText('● Paste a cURL command that starts with curl.');
  await expect(page.locator('#result-state')).toHaveClass(/failed/);
  await expect(page.locator('.results-pane')).toBeVisible();
  await expect(page.locator('#copy-result')).toBeHidden();
  await expect(page.locator('#result-output')).toBeHidden();
  await expect(page.locator('#error'), 'said once, in the result pane').toBeHidden();
  await page.waitForTimeout(600);
  await expect(page.locator('#result-state')).not.toContainText('Updating');
  await page.locator('#preview').fill('curl https://example.com/b');
  await expect(page.locator('.results-pane'), 'the pane stays while the next run starts').toBeVisible();
  await completed(page);
  await expect(page.locator('#result-output')).toHaveValue('await fetch("https://example.com/b");');
});

test('the result pane: one metrics line, plain action names, one OUTPUT label', async ({ page, host }) => {
  host.openPaths.push('fixture.json');
  await page.locator('#open-file').click();
  await completed(page);
  const size = host.files.get('fixture.json').bytes.length;
  await expect(page.locator('#result-metrics')).toHaveText(new RegExp(`^In ${size} B · Out \\d+ B · \\d+ ms$`));
  await expect(page.locator('#copy-result')).toHaveText('Copy');
  await expect(page.locator('#open-result')).toHaveText('Open as tab');
  await expect(page.locator('#save-result')).toHaveText('Save…');
  await expect(page.locator('.output-controls .small-badge')).toHaveCount(0);
  await expect(page.locator('.result-preview-heading .section-label')).toHaveText('OUTPUT');
  await expect(page.locator('#result-subtitle')).toHaveText('Updates as you type');
});

test('a generator whose operation reads no document shows no editor', async ({ page, host }) => {
  void host;
  await newText(page, 'kept for Decode');
  await chooseTool(page, 'UUID Generator');
  await completed(page);
  await expect(page.locator('#result-output')).toHaveValue(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  await expect(page.locator('#preview')).toBeHidden();
  await expect(page.locator('#input-message-text')).toHaveText('Generated from the options above; there is no input.');
  await expect(page.locator('.input-quick-actions')).toBeHidden();
  await page.getByRole('button', { name: 'Decode', exact: true }).click();
  await expect(page.locator('#preview')).toBeVisible();
  await expect(page.locator('#preview')).toHaveValue('kept for Decode');
  await expect(page.locator('.input-quick-actions')).toBeVisible();
});

test('Find & Replace says Match case; document size counts an unsaved text in UTF-8', async ({ page, host }) => {
  void host;
  await expect(page.locator('#source-size')).toHaveText('—');
  await newText(page, 'héllo');
  await expect(page.locator('#source-size')).toHaveText('6 B');
  await chooseTool(page, 'Find & Replace');
  const checks = await page.locator('.format-control label.check-option').allTextContents();
  expect(checks).toEqual(['Match case', 'Whole word']);
});
