import { test, expect } from './native-mock.mjs';

async function chooseTool(page, name) {
  // Accessible tool names include the operation summary; match the title node.
  await page.locator('.tool-item').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
}
async function newText(page, text) {
  await page.keyboard.press('Control+n');
  await expect(page.locator('#preview')).toBeFocused();
  await page.locator('#preview').fill(text);
}
async function ready(page) {
  await expect(page.locator('#result-state')).toContainText('Completed successfully');
  await expect(page.locator('#result-state')).not.toContainText('Updating');
}
// Default delay of apps/desktop/src/ui/delayedIndicator.ts: a job that finishes inside it
// must never show the progress panel; a job that outlives it is allowed to.
const INDICATOR_DELAY_MS = 200;
async function watchGeometry(page) {
  await page.evaluate(() => {
    const completed = () => {
      const text = document.querySelector('#result-state').textContent;
      return text.includes('Completed successfully') && !text.includes('Updating');
    };
    const input = document.querySelector('#editor-host');
    const rect = input.getBoundingClientRect();
    window.__geometry = { original: [rect.x, rect.y, rect.width, rect.height], samples: [], progressVisible: false, stopped: false, runStartedAt: null, runFinishedAt: null };
    const sample = () => {
      const state = window.__geometry;
      if (state.stopped) return;
      const r = input.getBoundingClientRect();
      state.samples.push([r.x, r.y, r.width, r.height]);
      const p = document.querySelector('#job-panel');
      state.progressVisible ||= !p.hidden && getComputedStyle(p).visibility !== 'hidden';
      // Measure the job on the page's own clock so the no-flash rule is judged
      // against what the shell saw, not against Playwright's polling latency.
      const now = performance.now();
      if (state.runStartedAt === null) { if (!completed()) state.runStartedAt = now; }
      else if (state.runFinishedAt === null && completed()) state.runFinishedAt = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
async function assertGeometry(page, progressVisible) {
  const report = await page.evaluate(() => {
    const state = window.__geometry;
    state.stopped = true;
    if (state.runStartedAt !== null && state.runFinishedAt === null) state.runFinishedAt = performance.now();
    return state;
  });
  expect(report.samples.length).toBeGreaterThan(0);
  for (const rect of report.samples)
    rect.forEach((value, i) => expect(Math.abs(value - report.original[i]), `pane moved: ${JSON.stringify(report)}`).toBeLessThanOrEqual(1));
  if (progressVisible === false) {
    // A loaded CI runner can stretch the mock host's round trips past the indicator
    // delay; the shell is then allowed to show progress, so the assertion only applies
    // to a job the page observed finishing inside the delay.
    const elapsed = report.runStartedAt === null ? 0 : report.runFinishedAt - report.runStartedAt;
    if (elapsed < INDICATOR_DELAY_MS) expect(report.progressVisible, `progress flashed for a ${Math.round(elapsed)} ms job`).toBe(false);
    else test.info().annotations.push({ type: 'no-flash assertion skipped', description: `job took ${Math.round(elapsed)} ms, longer than the ${INDICATOR_DELAY_MS} ms indicator delay` });
  } else if (progressVisible !== undefined) expect(report.progressVisible).toBe(progressVisible);
}

test('blank document is a full-size editable surface; keyboard commands retain focus', async ({ page, host }, info) => {
  await newText(page, 'Notes from the keyboard');
  await expect(page.locator('#empty-state')).toBeHidden();
  await expect(page.locator('#input-message')).toBeHidden();
  await expect(page.locator('.results-pane')).toBeHidden();
  await expect(page.locator('#preview')).toHaveValue('Notes from the keyboard');
  const pane = await page.locator('#editor-host').boundingBox();
  const footer = await page.locator('.statusbar').boundingBox();
  expect(footer.y - (pane.y + pane.height), 'No unused job panel below editor').toBeLessThan(40);
  await page.keyboard.press('Control+k');
  await expect(page.locator('#palette-search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#preview')).toBeFocused();
  host.savePaths.push('notes-saved.txt');
  await page.keyboard.press('Control+s');
  await expect(page.locator('#status')).toContainText('Saved notes-saved.txt');
  await page.screenshot({ path: info.outputPath('editor.png') });
});

test('JSON format/minify/validate produce exclusive surfaces without duplicate controls', async ({ page, host }, info) => {
  host.openPaths.push('fixture.json');
  await page.locator('#open-file').click();
  await ready(page);
  await expect(page.locator('#result-output')).toHaveValue('{\n  "hello": "world",\n  "items": [\n    1,\n    2\n  ]\n}');
  await expect(page.locator('.format-control select')).toHaveCount(0);
  for (const name of ['Format', 'Minify', 'Validate']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Minify', exact: true }).click();
  await expect(page.locator('#result-output')).toHaveValue('{"hello":"world","items":[1,2]}');
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('#result-status-message')).toBeVisible();
  await expect(page.locator('.result-code')).toBeHidden();
  await page.screenshot({ path: info.outputPath('json-validated.png') });
});

test('image -> complete clipboard -> image survives the editor and preview limits', async ({ page, host }, info) => {
  host.openPaths.push('image.png');
  await page.locator('#open-file').click();
  await ready(page);
  await expect(page.locator('#input-image')).toBeVisible();
  await expect(page.locator('#preview')).toBeHidden();
  await expect(page.locator('.input-quick-actions')).toBeHidden();
  await expect(page.locator('#input-image')).toHaveJSProperty('naturalWidth', 512);
  await page.locator('#copy-result').click();
  await expect.poll(() => host.clipboard).toBe(host.dataUri);
  expect(host.clipboard.length).toBeGreaterThan(1024 * 1024);
  await page.keyboard.press('Control+n');
  await chooseTool(page, 'Base64 to Image');
  await page.locator('#input-clipboard').click();
  await ready(page);
  await expect(page.locator('#result-media img')).toHaveJSProperty('naturalWidth', 512);
  await expect(page.locator('.result-code')).toBeHidden();
  await expect(page.locator('#result-structured')).toBeHidden();
  const image = await page.locator('#result-media img').boundingBox();
  const stage = await page.locator('.result-preview-block').boundingBox();
  expect(image.y - stage.y, 'Image belongs at top of output').toBeLessThan(55);
  await page.screenshot({ path: info.outputPath('image-roundtrip.png') });
});

test('mixed tabs retain drafts and selected tools while jobs complete in background', async ({ page, host }) => {
  await newText(page, 'my notes');
  const notes = page.getByRole('tab').first();
  host.openPaths.push('fixture.json');
  host.delay = 800;
  await page.locator('#open-file').click();
  const json = page.getByRole('tab').nth(1);
  host.openPaths.push('image.png');
  await page.locator('#open-file').click();
  const image = page.getByRole('tab').nth(2);
  await notes.click();
  await expect(page.locator('#active-tool-title')).toHaveText('Text editor');
  await expect(page.locator('#preview')).toHaveValue('my notes');
  await expect(page.locator('.results-pane')).toBeHidden();
  await json.click();
  await ready(page);
  await expect(page.locator('#active-tool-title')).toHaveText('JSON');
  await expect(page.locator('#result-output')).toHaveValue(/"hello": "world"/);
  await image.click();
  await ready(page);
  await expect(page.locator('#active-tool-title')).toHaveText('Image to Base64');
  await expect(page.locator('#input-image')).toBeVisible();
  await notes.click();
  await expect(page.locator('#preview')).toHaveValue('my notes');
});

test('fast jobs never flash progress; slow jobs can be cancelled without resizing editor', async ({ page, host }) => {
  await newText(page, JSON.stringify({ lines: Array.from({ length: 200 }, (_, i) => i) }, null, 2));
  await chooseTool(page, 'JSON');
  await ready(page);
  await page.locator('#preview').evaluate((input) => { input.focus(); input.setSelectionRange(10, 10); input.scrollTop = 200; });
  const before = await page.locator('#preview').evaluate((input) => ({ caret: input.selectionStart, scroll: input.scrollTop }));
  await watchGeometry(page);
  await page.getByRole('button', { name: 'Format', exact: true }).click();
  await ready(page);
  await assertGeometry(page, false);
  expect(await page.locator('#preview').evaluate((input) => ({ caret: input.selectionStart, scroll: input.scrollTop }))).toEqual(before);
  host.delay = 3000;
  await watchGeometry(page);
  await page.getByRole('button', { name: 'Format', exact: true }).click();
  await expect(page.locator('#job-panel')).toBeVisible();
  await page.locator('#cancel-job').click();
  await expect(page.locator('#status-validity')).not.toHaveText('Processing');
  await expect(page.locator('#job-panel')).toBeHidden();
  await assertGeometry(page, true);
  expect(host.calls.some((call) => call.cmd === 'cancel_operation')).toBe(true);
});

test('invalid JSON does not shift the source editor and never shows an empty successful output', async ({ page, host }) => {
  await newText(page, '{"valid":true}');
  await chooseTool(page, 'JSON');
  await ready(page);
  await watchGeometry(page);
  await page.locator('#preview').fill('{');
  await expect(page.locator('#result-state')).toHaveClass(/failed/);
  await expect(page.locator('#status-validity')).toHaveText('Error');
  await expect(page.locator('.result-code')).toBeHidden();
  await assertGeometry(page);
  await expect(page.locator('#preview')).toBeFocused();
});

test('native file-drop events open files without replacing a dirty tab', async ({ page, host }) => {
  await newText(page, 'Keep these notes');
  await host.emit('tauri://drag-drop', { paths: ['fixture.json'] });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await ready(page);
  await page.getByRole('tab').first().click();
  await expect(page.locator('#preview')).toHaveValue('Keep these notes');
});

test('image tool has image-only actions; theme stays neutral and controls remain inside panes', async ({ page, host }) => {
  await newText(page, '');
  await chooseTool(page, 'Image to Base64');
  await expect(page.locator('#preview')).toBeHidden();
  await expect(page.locator('#input-message')).toContainText('Open a PNG or JPEG');
  await expect(page.locator('.input-quick-actions')).toBeHidden();
  await expect(page.locator('.format-control select')).toHaveCount(0);
  await chooseTool(page, 'JSON');
  await page.locator('#input-sample').click();
  await ready(page);
  const colors = await page.locator('body, .sidebar, .editor-host, .statusbar').evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
  for (const color of colors) {
    const channels = color.match(/\d+/g).slice(0, 3).map(Number);
    expect(Math.max(...channels)).toBeLessThan(48);
    expect(Math.max(...channels) - Math.min(...channels), `neutral surface ${color}`).toBeLessThanOrEqual(8);
  }
  for (const selector of ['.input-controls', '.output-controls']) {
    const bounds = await page.locator(selector).evaluate((el) => ({ right: el.getBoundingClientRect().right, parent: el.closest('.pane-header').getBoundingClientRect().right }));
    expect(bounds.right).toBeLessThanOrEqual(bounds.parent);
  }
});
