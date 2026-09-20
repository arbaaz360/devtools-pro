import { test, expect } from './native-mock.mjs';

// The webview's worker engine runs v2 package processors for real here: only
// the native IPC is mocked, so the input snapshot, the Worker, the processor
// and the result document all take the shipped path.
async function chooseTool(page, name) {
  await page.locator('.tool-item').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click();
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

test('package tools appear beside native tools and native ids stay native', async ({ page, host }) => {
  const names = await page.locator('.tool-item strong').allTextContents();
  expect(names).toContain('String Case Converter');
  expect(names).toContain('Base64 Text');
  expect(names).toContain('URL Parser');
  // The mock host serves text.url itself, so the url package's tool with that id stays native
  // and the sidebar shows the native entry once, not the package's title as well.
  expect(names).toContain('URL encode / decode');
  expect(names).not.toContain('URL Encode / Decode');
  expect(names.filter((name) => name === 'String Case Converter').length).toBe(1);
  expect(host.calls.some((call) => call.cmd === 'list_tools')).toBe(true);
});

test('a package tool converts input through the worker engine with its declared options', async ({ page, host }) => {
  await newText(page, 'userID_loaderHTTPServer v2Api');
  await chooseTool(page, 'String Case Converter');
  await completed(page);
  await expect(page.locator('#result-content')).toContainText('userIDLoaderHTTPServerV2API');
  await page.getByLabel('Target').selectOption('snake');
  await completed(page);
  await expect(page.locator('#result-content')).toContainText('user_id_loader_http_server_v_2_api');
  await expect(page.locator('#result-summary')).toContainText('acronymsApplied: 3');
  await page.getByLabel('Preserve Acronyms').uncheck();
  await completed(page);
  await expect(page.locator('#result-content')).toContainText('user_id_loader_http_server_v_2_api');
  await expect(page.locator('#result-summary')).toContainText('acronymsApplied: 0');
  // No native run_tool call was made for a package tool; the result is a host document.
  expect(host.calls.filter((call) => call.cmd === 'run_tool').length).toBe(0);
  expect(host.calls.filter((call) => call.cmd === 'create_text_document' && call.args.name === 'String Case Converter.txt').length).toBeGreaterThan(0);
});

test('a processor error reaches the result pane as a structured failure', async ({ page, host }) => {
  void host;
  await newText(page, 'aGVsbG8=');
  await chooseTool(page, 'Base64 Text');
  await completed(page);
  await page.getByLabel('Mode').selectOption('decode');
  await completed(page);
  await expect(page.locator('#result-content')).toContainText('hello');
  await page.locator('#preview').fill('not base64!!');
  await expect(page.locator('#result-state')).toHaveClass(/failed/);
  await expect(page.locator('#result-state')).toContainText('●');
});

test('a sensitive package option is a masked input and the tool runs with it', async ({ page, host }) => {
  void host;
  await newText(page, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  await chooseTool(page, 'JWT Decoder & Verifier');
  await completed(page);
  await expect(page.locator('#result-summary')).toContainText('signature: not-checked');
  const key = page.getByLabel('Key');
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('your-256-bit-secret');
  await key.press('Tab');
  await completed(page);
  await expect(page.locator('#result-summary')).toContainText('signature: valid');
  await expect(page.locator('#result-content')).not.toContainText('your-256-bit-secret');
});
