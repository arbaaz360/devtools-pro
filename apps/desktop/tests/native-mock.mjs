import { readFileSync } from 'node:fs';
import { test as base, expect } from '@playwright/test';

/** Mock only IPC, events, dialogs and clipboard. App modules/DOM stay real.
 * This is UI evidence, not evidence that the Rust host or OS dialogs work. */
class NativeMock {
  constructor(page) {
    this.page = page;
    this.next = 0;
    this.documents = new Map();
    this.jobs = new Map();
    this.calls = [];
    this.delay = 15;
    this.openPaths = [];
    this.savePaths = [];
    this.clipboard = '';
    this.timers = new Set();
    const png = readFileSync(new URL('../../../benchmarks/fixtures/clipboard-roundtrip.png', import.meta.url));
    this.png = png;
    this.dataUri = `data:image/png;base64,${png.toString('base64')}`;
    this.files = new Map([
      ['fixture.json', { bytes: Buffer.from('{"hello":"world","items":[1,2]}'), format: 'json' }],
      ['image.png', { bytes: png, mime: 'image/png' }],
      ['notes.txt', { bytes: Buffer.from('Original notes'), format: 'text' }],
    ]);
  }
  document(name, bytes, format = 'text', mime = null) {
    const id = `document-${++this.next}`;
    this.documents.set(id, { id, name, bytes, format, mime });
    return this.preview(id);
  }
  preview(id, offset = 0) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`Mock: closed/unknown document ${id}`);
    const image = !!doc.mime?.startsWith('image/');
    const end = Math.min(offset + 65536, doc.bytes.length);
    return {
      id, name: doc.name, path: doc.name, size: doc.bytes.length,
      preview: image ? '' : doc.bytes.subarray(offset, end).toString('utf8'),
      truncated: end < doc.bytes.length, format: doc.format, encoding: 'UTF-8',
      contentKind: image ? 'image' : 'text', mime: doc.mime ?? 'text/plain',
      editable: !image && doc.bytes.length <= 1024 * 1024,
      offset, bytesRead: end - offset,
    };
  }
  async emit(name, payload) {
    if (this.page.isClosed()) return;
    await this.page.evaluate(({ name, payload }) => window.__testEmit(name, payload), { name, payload });
  }
  async install() {
    await this.page.exposeFunction('__mockInvoke', (cmd, args) => this.invoke(cmd, args));
    await this.page.exposeFunction('__mockClipboardRead', () => this.clipboard);
    await this.page.exposeFunction('__mockClipboardWrite', (value) => { this.clipboard = value; });
    await this.page.addInitScript(() => {
      let nextCallback = 0;
      const callbacks = new Map();
      const listeners = new Map();
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback) { const id = ++nextCallback; callbacks.set(id, callback); return id; },
        async invoke(cmd, args) {
          if (cmd === 'plugin:event|listen') {
            listeners.set(args.handler, { event: args.event, callback: args.handler });
            return args.handler;
          }
          if (cmd === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          return window.__mockInvoke(cmd, args);
        },
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { listeners.delete(id); } };
      window.__testEmit = (event, payload) => {
        for (const [id, listener] of listeners)
          if (listener.event === event) callbacks.get(listener.callback)?.({ event, payload, id });
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: () => window.__mockClipboardRead(),
        writeText: (value) => window.__mockClipboardWrite(value),
      } });
    });
  }
  invoke(cmd, args = {}) {
    this.calls.push({ cmd, args });
    switch (cmd) {
      case 'plugin:dialog|open': return this.openPaths.shift() ?? null;
      case 'plugin:dialog|save': return this.savePaths.shift() ?? null;
      case 'open_document': {
        const file = this.files.get(args.path);
        if (!file) throw new Error(`Mock: unknown file ${args.path}`);
        return this.document(args.path, file.bytes, file.format, file.mime);
      }
      case 'create_text_document': return this.document(args.name ?? 'Untitled.txt', Buffer.from(args.text), args.format);
      case 'read_preview': return this.preview(args.documentId, args.offset);
      case 'read_binary_preview': {
        const doc = this.documents.get(args.documentId);
        if (!doc?.mime?.startsWith('image/')) throw new Error('Mock: not an image');
        return { mime: doc.mime, bytes: doc.bytes.length, truncated: false, data: `data:${doc.mime};base64,${doc.bytes.toString('base64')}` };
      }
      case 'close_document': this.documents.delete(args.documentId); return;
      case 'list_tools': return ['structured.json', 'encoding.image-base64', 'encoding.base64-image', 'text.compare', 'text.url'].map((id) => ({
        id, label: id, contractVersion: 1, inputKinds: ['text', 'bytes'],
        limits: { maxInputBytes: null, maxOutputBytes: null }, capabilities: {}, operations: [], renderer: 'text',
      }));
      case 'run_tool': return this.run(args);
      case 'job_status': return this.jobs.get(args.jobId)?.event ?? null;
      case 'cancel_operation': {
        const job = this.jobs.get(args.jobId);
        if (job && !job.event) {
          clearTimeout(job.timer);
          this.timers.delete(job.timer);
          job.event = { jobId: args.jobId, ok: false, cancelled: true, elapsedMs: 0, inputBytes: 0, summary: null };
          return this.emit('job-finished', job.event);
        }
        return;
      }
      case 'save_document':
      case 'save_result': if (!this.documents.has(args.documentId ?? args.resultDocumentId)) throw new Error('Mock: saving missing document'); return;
      default: throw new Error(`Unmocked IPC command: ${cmd}`);
    }
  }
  run(args) {
    const doc = this.documents.get(args.documentId);
    if (!doc) throw new Error('Mock: missing input');
    const jobId = `job-${++this.next}`;
    const job = {};
    this.jobs.set(jobId, job);
    const delay = this.delay;
    job.timer = setTimeout(async () => {
      this.timers.delete(job.timer);
      let output;
      const event = { jobId, ok: true, cancelled: false, inputBytes: doc.bytes.length, elapsedMs: delay,
        operationId: args.operationId, sourceDocumentId: doc.id, summary: 'Mock completed', renderer: 'text' };
      try {
        if (args.toolId === 'structured.json') {
          const value = JSON.parse(doc.bytes.toString('utf8'));
          if (args.operationId !== 'inspect') output = this.document('result.json', Buffer.from(JSON.stringify(value, null, args.operationId === 'format' ? 2 : 0)), 'json', 'application/json');
        } else if (args.toolId === 'encoding.image-base64') {
          output = this.document('result.base64.txt', Buffer.from(`data:${doc.mime};base64,${doc.bytes.toString('base64')}`));
        } else if (args.toolId === 'encoding.base64-image') {
          // Independent equality oracle: this round trip must contain the WHOLE fixture.
          if (doc.bytes.toString('utf8') !== this.dataUri) throw new Error('Mock: truncated or changed Base64 payload');
          output = this.document('result.png', this.png, 'text', 'image/png');
          event.renderer = 'binary'; event.resultMime = 'image/png';
        } else if (args.toolId === 'text.url') {
          output = this.document('result.txt', Buffer.from(encodeURIComponent(doc.bytes.toString('utf8'))));
        } else throw new Error(`Unmocked tool ${args.toolId}`);
        if (output) { event.resultDocumentId = output.id; event.outputBytes = output.size; }
      } catch (error) { event.ok = false; event.error = error.message; }
      job.event = event;
      await this.emit('job-finished', event);
    }, delay);
    this.timers.add(job.timer);
    return { jobId };
  }
  dispose() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}

export const test = base.extend({
  host: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const host = new NativeMock(page);
    await host.install();
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('Engine connected');
    try { await use(host); } finally { host.dispose(); }
    expect(errors, 'uncaught errors in the real app bundle').toEqual([]);
  },
});
export { expect };
