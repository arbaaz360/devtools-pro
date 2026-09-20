import { test, expect } from './native-mock.mjs';

// Result representations beyond text: a sandboxed frame for text/html, an image for
// SVG, and editor highlights for annotations. The mock host supplies the events; the
// rendering is the real shell.
async function chooseTool(page, name) {
  await page.locator('.tool-item').filter({ has: page.locator('strong', { hasText: name }) }).first().click();
}
async function newText(page, text) {
  await page.keyboard.press('Control+n');
  await expect(page.locator('#preview')).toBeFocused();
  await page.locator('#preview').fill(text);
}
async function completed(page) {
  await expect(page.locator('#result-state')).toContainText('Completed successfully');
  await expect(page.locator('#result-state')).not.toContainText('Updating');
}

test('a text/html result renders in a frame with every sandbox permission withheld', async ({ page, host }) => {
  await newText(page, '<h1>Hi there</h1>');
  await chooseTool(page, 'Preview (mock)');
  await completed(page);
  const frame = page.locator('#result-media iframe.preview-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', '');
  const inner = page.frameLocator('#result-media iframe.preview-frame');
  await expect(inner.locator('h1')).toHaveText('Hi there');
  // The script inside the document must not have run.
  expect(await inner.locator('body').getAttribute('data-ran')).toBeNull();
  await expect(page.locator('#result-output')).toBeHidden();
  await page.locator('#copy-result').click();
  expect(host.clipboard).toContain('<h1>Hi there</h1>');
});

test('an SVG result renders as an image from its own text', async ({ page, host }) => {
  void host;
  await newText(page, 'anything');
  await chooseTool(page, 'SVG (mock)');
  await completed(page);
  const image = page.locator('#result-media img.binary-preview');
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src');
  expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  expect(decodeURIComponent(src)).toContain('<rect');
});

test('annotations highlight the editor text and hide once the text changes', async ({ page, host }) => {
  void host;
  await newText(page, 'hello brave world');
  await chooseTool(page, 'Annotate (mock)');
  await completed(page);
  const layer = page.locator('#editor-highlight');
  await expect(layer).toBeVisible();
  await expect(page.locator('#preview')).toHaveClass(/annotated/);
  await expect(layer.locator('mark.ann-match')).toHaveCount(6);
  await expect(layer.locator('mark.ann-group')).toHaveCount(3);
  // The layer's text is the editor's text, so highlights sit under their characters.
  expect(await layer.innerText()).toBe('hello brave world');
  // Editing makes the result stale: highlights go until the next result lands.
  await page.locator('#preview').press('End');
  await page.locator('#preview').type('!');
  await expect(layer).toBeHidden();
  await completed(page);
  await expect(layer).toBeVisible();
  expect(await layer.innerText()).toBe('hello brave world!');
});
