import { test, expect } from './native-mock.mjs';

// AG-003: the two-source compare workspace. The native bridge is mocked; the
// mock's line diff mirrors the Rust executor's output shape.

async function openCompare(page) {
  await page.keyboard.press('Control+n');
  await page.locator('.tool-item').filter({ has: page.locator('strong', { hasText: /^Diff & Compare$/ }) }).click();
  await expect(page.locator('#compare-left')).toBeVisible();
  await expect(page.locator('#compare-right')).toBeVisible();
}
async function compared(page) {
  await expect(page.locator('#result-state')).toContainText('Completed successfully');
  await expect(page.locator('#result-state')).not.toContainText('Updating');
}
const left = (page) => page.locator('#compare-left');
const right = (page) => page.locator('#compare-right');
const label = (page, side) => page.locator(`[data-label="${side}"]`);
const dirty = (page, side) => page.locator(`[data-dirty="${side}"]`);
const summary = (page) => page.locator('.diff-summary strong');
const status = (page) => page.locator('#preview-limit');
const compareCalls = (host) => host.calls.filter((call) => call.cmd === 'run_compare').length;

test('both editors accept typing; compare needs both sides and covers identical, insertion, deletion and replacement', async ({ page, host }, info) => {
  await openCompare(page);
  await expect(page.locator('#editor-host')).toBeHidden();
  await expect(page.locator('.results-pane'), 'no blank result surface before the first comparison').toBeHidden();
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeDisabled();
  await expect(status(page)).toContainText('Both sides are empty');
  await expect(page.locator('#error')).toBeHidden();

  await left(page).fill('alpha\nbeta\ngamma\n');
  await expect(status(page)).toContainText('Right / revised is empty');
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(compareCalls(host), 'an empty side never reaches the host').toBe(0);
  await expect(page.locator('.results-pane')).toBeHidden();

  await right(page).fill('alpha\nbeta\ngamma\n');
  await compared(page);
  await expect(page.locator('.results-pane')).toBeVisible();
  await expect(summary(page)).toHaveText('No differences');
  await expect(page.locator('.diff-empty')).toBeVisible();
  await expect(page.locator('.result-code'), 'raw JSON is not the default surface').toBeHidden();
  await expect(page.locator('.diff-raw')).not.toHaveAttribute('open', '');
  await expect(page.locator('.diff-raw pre')).toBeHidden();
  await expect(left(page), 'editing the right side leaves the left untouched').toHaveValue('alpha\nbeta\ngamma\n');
  await expect(status(page)).toContainText('No differences');
  await page.screenshot({ path: info.outputPath('compare-identical.png') });

  await right(page).fill('alpha\nbeta\ngamma\ndelta\n');
  await compared(page);
  await expect(summary(page)).toHaveText('1 change · +1 −0');
  await expect(page.locator('.diff-line.added .diff-line-text')).toHaveText('delta');
  await expect(page.locator('.diff-line.removed')).toHaveCount(0);

  await right(page).fill('alpha\ngamma\n');
  await compared(page);
  await expect(summary(page)).toHaveText('1 change · +0 −1');
  await expect(page.locator('.diff-line.removed .diff-line-text')).toHaveText('beta');
  await expect(page.locator('.diff-line.added')).toHaveCount(0);

  await right(page).fill('alpha\nBETA\ngamma\n');
  await compared(page);
  await expect(summary(page)).toHaveText('1 change · +1 −1');
  await expect(page.locator('.diff-line.removed .diff-line-text')).toHaveText('beta');
  await expect(page.locator('.diff-line.added .diff-line-text')).toHaveText('BETA');
  await expect(page.locator('.diff-hunk-title')).toHaveText('Original 1–3 → Revised 1–3');
  await expect(right(page), 'the right side keeps its own text').toHaveValue('alpha\nBETA\ngamma\n');
  await expect(left(page)).toHaveValue('alpha\nbeta\ngamma\n');

  await left(page).fill('alpha\nBETA\ngamma\n');
  await compared(page);
  await expect(summary(page)).toHaveText('No differences');
  await expect(right(page), 'editing the left side leaves the right untouched').toHaveValue('alpha\nBETA\ngamma\n');

  // Line-ending differences come from files (textareas hold LF only); they are
  // visible with Preserve and vanish when normalized.
  host.files.set('crlf.txt', { bytes: Buffer.from('one\r\ntwo\r\n'), format: 'text' });
  host.openPaths.push('crlf.txt');
  await page.locator('#compare-open-left').click();
  await expect(label(page, 'left')).toHaveText('crlf.txt');
  await expect(left(page)).toHaveValue('one\ntwo\n');
  await right(page).fill('one\ntwo\n');
  await compared(page);
  await expect(summary(page)).toHaveText('1 change · +2 −2');
  await expect(page.locator('.diff-summary')).toContainText('line endings also differ');
  await expect(page.locator('.diff-line.removed .diff-line-eol').first()).toHaveText('␍');
  await expect(dirty(page, 'left'), 'a CRLF file shown in an LF textarea is not an edit').toBeHidden();
  await page.getByLabel('Compare newline handling').selectOption('lf');
  await compared(page);
  await expect(summary(page)).toHaveText('No differences');

  // Clearing a side after a result keeps the pane in place and reports the gap.
  const before = compareCalls(host);
  await page.locator('button[data-action="right"]', { hasText: 'Clear' }).click();
  await expect(right(page)).toHaveValue('');
  await expect(status(page)).toContainText('Right / revised is empty');
  await expect(page.locator('#result-empty-title')).toHaveText('Both sources are needed');
  await expect(page.locator('#result-empty-text')).toContainText('Right / revised is empty');
  await expect(page.locator('.results-pane'), 'the pane stays so the editors do not reflow').toBeVisible();
  await page.waitForTimeout(500);
  expect(compareCalls(host)).toBe(before);
  await expect(left(page)).toHaveValue('one\ntwo\n');
  await page.screenshot({ path: info.outputPath('compare-empty-side.png') });
});

test('each side opens its own file, keeps its label and dirty state, and Swap exchanges inputs and labels', async ({ page, host }, info) => {
  await openCompare(page);
  host.openPaths.push('notes.txt');
  await page.locator('#compare-open-left').click();
  await expect(left(page)).toHaveValue('Original notes');
  await expect(label(page, 'left')).toHaveText('notes.txt');
  await expect(dirty(page, 'left')).toBeHidden();
  await expect(page.getByRole('tab'), 'opening into a side never creates a tab').toHaveCount(1);
  await expect(page.locator('#active-tool-title')).toHaveText('Diff & Compare');

  host.openPaths.push('fixture.json');
  await page.locator('#compare-open-right').click();
  await expect(right(page)).toHaveValue('{"hello":"world","items":[1,2]}');
  await expect(label(page, 'right')).toHaveText('fixture.json');
  await expect(dirty(page, 'right')).toBeHidden();
  await compared(page);
  await expect(summary(page)).toHaveText('1 change · +1 −1');
  await expect(page.locator('.diff-line.removed .diff-line-text')).toContainText('Original notes');
  await expect(page.locator('.diff-line.added .diff-line-text')).toContainText('"hello"');

  await right(page).fill('{"hello":"world","items":[1,2]}\nappended\n');
  await expect(dirty(page, 'right'), 'editing a file-backed side marks only that side').toBeVisible();
  await expect(dirty(page, 'left')).toBeHidden();
  await expect(label(page, 'right')).toHaveText('fixture.json');
  await compared(page);

  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(left(page)).toHaveValue('{"hello":"world","items":[1,2]}\nappended\n');
  await expect(right(page)).toHaveValue('Original notes');
  await expect(label(page, 'left')).toHaveText('fixture.json');
  await expect(dirty(page, 'left')).toBeVisible();
  await expect(label(page, 'right')).toHaveText('notes.txt');
  await expect(dirty(page, 'right')).toBeHidden();
  await compared(page);
  await expect(page.locator('.diff-line.removed .diff-line-text').first()).toContainText('"hello"');
  await expect(page.locator('.diff-line.added .diff-line-text')).toContainText('Original notes');
  await page.screenshot({ path: info.outputPath('compare-swapped.png') });

  // Swapping back restores the original labels and direction.
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(label(page, 'left')).toHaveText('notes.txt');
  await expect(label(page, 'right')).toHaveText('fixture.json');
  await expect(dirty(page, 'right')).toBeVisible();
  await compared(page);
  await expect(page.locator('.diff-line.removed .diff-line-text')).toContainText('Original notes');

  // A dialog cancel leaves both sides untouched.
  await page.locator('#compare-open-left').click();
  await expect(left(page)).toHaveValue('Original notes');
  await expect(label(page, 'left')).toHaveText('notes.txt');
});

test('clipboard fills either side independently and reports an empty clipboard on that side only', async ({ page, host }) => {
  await openCompare(page);
  host.clipboard = '';
  await page.locator('button[data-action="right"]', { hasText: 'Clipboard' }).click();
  await expect(page.locator('[data-issue="right"]')).toContainText('clipboard has no text');
  await expect(page.locator('[data-issue="left"]')).toBeHidden();
  host.clipboard = 'pasted line\n';
  await page.locator('button[data-action="right"]', { hasText: 'Clipboard' }).click();
  await expect(right(page)).toHaveValue('pasted line\n');
  await expect(page.locator('[data-issue="right"]')).toBeHidden();
  await expect(left(page)).toHaveValue('');
  await left(page).fill('typed line\n');
  await page.locator('button[data-action="left"]', { hasText: 'Clipboard' }).click();
  await expect(left(page)).toHaveValue('pasted line\n');
  await expect(right(page)).toHaveValue('pasted line\n');
  await compared(page);
  await expect(summary(page)).toHaveText('No differences');
  await expect(label(page, 'left')).toHaveText('Unsaved text');
  await expect(label(page, 'right')).toHaveText('Unsaved text');
});

test('change navigation walks every change and word/character granularity is clearly unavailable', async ({ page, host }, info) => {
  await openCompare(page);
  // Changes at b and k sit more than three context lines apart, so two hunks.
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  await left(page).fill(lines.join('\n') + '\n');
  await right(page).fill(lines.map((line) => (line === 'b' ? 'B' : line === 'k' ? 'K' : line)).join('\n') + '\n');
  await compared(page);
  await expect(summary(page)).toHaveText('2 changes · +2 −2');
  await expect(page.locator('.diff-hunk')).toHaveCount(2);
  const counter = page.locator('.diff-nav-count');
  await expect(counter).toHaveText('– / 2');
  await expect(page.getByRole('button', { name: 'Previous change' })).toBeDisabled();
  await page.getByRole('button', { name: 'Next change' }).click();
  await expect(counter).toHaveText('1 / 2');
  await expect(page.locator('.diff-line.current')).toHaveCount(2);
  await expect(page.locator('.diff-line.current.removed .diff-line-text')).toHaveText('b');
  await page.getByRole('button', { name: 'Next change' }).click();
  await expect(counter).toHaveText('2 / 2');
  await expect(page.locator('.diff-line.current.added .diff-line-text')).toHaveText('K');
  await expect(page.getByRole('button', { name: 'Next change' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous change' }).click();
  await expect(counter).toHaveText('1 / 2');
  await expect(page.locator('.compare-granularity button', { hasText: 'Line' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.compare-granularity button', { hasText: 'Word' })).toBeDisabled();
  await expect(page.locator('.compare-granularity button', { hasText: 'Character' })).toBeDisabled();
  await expect(page.locator('.compare-granularity button', { hasText: 'Character' })).toHaveAttribute('title', /not available/);
  await page.screenshot({ path: info.outputPath('compare-navigation.png') });
});

test('switching tabs restores the same pair, labels, result and selected change without touching other tabs', async ({ page, host }) => {
  await openCompare(page);
  host.openPaths.push('notes.txt');
  await page.locator('#compare-open-left').click();
  await expect(label(page, 'left')).toHaveText('notes.txt');
  await right(page).fill('Original notes\nsecond\n');
  await compared(page);
  await expect(summary(page)).toHaveText('1 change · +2 −1');
  await page.getByRole('button', { name: 'Next change' }).click();
  await expect(page.locator('.diff-nav-count')).toHaveText('1 / 1');
  const compareTab = page.getByRole('tab').first();

  await page.keyboard.press('Control+n');
  await expect(page.locator('#preview')).toBeFocused();
  await page.locator('#preview').fill('scratch notes');
  await expect(page.locator('#compare-left')).toBeHidden();
  await expect(page.locator('.results-pane')).toBeHidden();
  const calls = compareCalls(host);

  await compareTab.click();
  await expect(page.locator('#active-tool-title')).toHaveText('Diff & Compare');
  await expect(left(page)).toHaveValue('Original notes');
  await expect(right(page)).toHaveValue('Original notes\nsecond\n');
  await expect(label(page, 'left')).toHaveText('notes.txt');
  await expect(label(page, 'right')).toHaveText('Unsaved text');
  await expect(page.locator('.results-pane')).toBeVisible();
  await expect(summary(page)).toHaveText('1 change · +2 −1');
  await expect(page.locator('.diff-nav-count')).toHaveText('1 / 1');
  await expect(page.locator('.diff-line.current')).toHaveCount(3);
  await expect(page.locator('#result-state')).not.toContainText('Updating');
  expect(compareCalls(host), 'restoring a tab does not recompute its result').toBe(calls);
  await expect(page.locator('#compare-left')).toBeFocused();

  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('#preview')).toHaveValue('scratch notes');
  await expect(page.locator('#active-tool-title')).toHaveText('Text editor');
});

test('the editors use the pane height and the result stacks below without shrinking them away', async ({ page, host }, info) => {
  await openCompare(page);
  const pane = await page.locator('.preview-pane').boundingBox();
  const leftBox = await left(page).boundingBox();
  const rightBox = await right(page).boundingBox();
  expect(leftBox.height, 'editors fill the source pane before any result').toBeGreaterThan(pane.height * 0.6);
  expect(Math.abs(leftBox.height - rightBox.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(1);
  expect(leftBox.x + leftBox.width).toBeLessThanOrEqual(rightBox.x + 1);
  await left(page).fill('first\n');
  await right(page).fill('second\n');
  await compared(page);
  const result = await page.locator('.results-pane').boundingBox();
  const editors = await left(page).boundingBox();
  const sources = await page.locator('.preview-pane').boundingBox();
  expect(result.y, 'result stacks below the sources').toBeGreaterThanOrEqual(sources.y + sources.height - 1);
  expect(Math.abs(result.width - sources.width), 'both panes span the workspace').toBeLessThanOrEqual(2);
  expect(editors.height).toBeGreaterThan(120);
  expect(result.height).toBeGreaterThan(120);
  await expect(page.locator('#workspace-splitter')).toHaveAttribute('aria-orientation', 'horizontal');
  await page.screenshot({ path: info.outputPath('compare-layout.png') });
});
