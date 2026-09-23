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
      case 'list_tools': return [
        ...['structured.json', 'encoding.image-base64', 'encoding.base64-image', 'text.compare', 'text.url'].map((id) => ({
          id, label: id, contractVersion: 1, inputKinds: ['text', 'bytes'],
          limits: { maxInputBytes: null, maxOutputBytes: null }, capabilities: {}, operations: [], renderer: 'text',
        })),
        // Renderer probes: each returns a text result the shell shows in a different way.
        ...[['mock.preview', 'Preview (mock)', 'preview'], ['mock.svg', 'SVG (mock)', 'svg'], ['mock.annotate', 'Annotate (mock)', 'text']].map(([id, label, renderer]) => ({
          id, label, contractVersion: 1, inputKinds: ['text'], group: 'MOCKS', auto: true,
          limits: { maxInputBytes: null, maxOutputBytes: null }, capabilities: {}, operations: [{ id: 'run', label: 'Run', defaultOptions: {} }], renderer,
        })),
      ];
      case 'run_tool': return this.run(args);
      case 'run_compare': return this.compare(args);
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
      case 'save_document': {
        // As the host does: the tab belongs to the file it just wrote afterwards.
        const doc = this.documents.get(args.documentId);
        if (!doc) throw new Error('Mock: saving missing document');
        return this.document(args.outputPath, doc.bytes, doc.format, doc.mime);
      }
      case 'save_result': if (!this.documents.has(args.resultDocumentId)) throw new Error('Mock: saving missing document'); return;
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
        } else if (args.toolId === 'mock.preview') {
          output = this.document('result.html', Buffer.from(`<!DOCTYPE html><html><body>${doc.bytes.toString('utf8')}<script>document.body.dataset.ran='yes'</script></body></html>`));
          event.renderer = 'preview'; event.resultMime = 'text/html';
        } else if (args.toolId === 'mock.svg') {
          output = this.document('result.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#000"/></svg>'));
          event.renderer = 'svg'; event.resultMime = 'image/svg+xml';
        } else if (args.toolId === 'mock.annotate') {
          // Every word is a match; the first character of each is a group.
          const text = doc.bytes.toString('utf8');
          const annotations = [];
          for (const match of text.matchAll(/\S+/g)) {
            annotations.push({ start: match.index, end: match.index + match[0].length, kind: 'match', label: `#${annotations.length / 2 + 1}` });
            annotations.push({ start: match.index, end: match.index + 1, kind: 'group', label: 'first' });
          }
          output = this.document('result.txt', Buffer.from(`${annotations.length / 2} words`));
          event.annotations = annotations;
        } else throw new Error(`Unmocked tool ${args.toolId}`);
        if (output) { event.resultDocumentId = output.id; event.outputBytes = output.size; }
      } catch (error) { event.ok = false; event.error = error.message; }
      job.event = event;
      await this.emit('job-finished', event);
    }, delay);
    this.timers.add(job.timer);
    return { jobId };
  }
  /** Same shape as crates/devtools-core/src/compare.rs: inclusive line split,
   * LCS ops, 3 context lines per hunk, and the executor's summary string. */
  compare(args) {
    const left = this.documents.get(args.leftDocumentId);
    const right = this.documents.get(args.rightDocumentId);
    if (!left || !right) throw new Error('Mock: missing compare input');
    const jobId = `job-${++this.next}`;
    const job = {};
    this.jobs.set(jobId, job);
    const delay = this.delay;
    job.timer = setTimeout(async () => {
      this.timers.delete(job.timer);
      const event = { jobId, ok: true, cancelled: false, inputBytes: left.bytes.length + right.bytes.length, elapsedMs: delay,
        operationId: 'compare', sourceDocumentId: left.id, summary: null, renderer: 'diff' };
      try {
        const mode = args.options?.newline ?? 'preserve';
        const normalize = (text) => {
          if (mode === 'preserve') return text;
          const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return mode === 'cr_lf' ? lf.replace(/\n/g, '\r\n') : lf;
        };
        const rawLeft = left.bytes.toString('utf8');
        const rawRight = right.bytes.toString('utf8');
        const leftText = normalize(rawLeft);
        const rightText = normalize(rawRight);
        const split = (text) => (text ? text.split(/(?<=\n)/) : []);
        const a = split(leftText);
        const b = split(rightText);
        const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--)
          for (let j = b.length - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const ops = [];
        for (let i = 0, j = 0; i < a.length || j < b.length;) {
          if (i < a.length && j < b.length && a[i] === b[j]) { ops.push(['context', a[i]]); i++; j++; }
          else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { ops.push(['added', b[j]]); j++; }
          else { ops.push(['removed', a[i]]); i++; }
        }
        const context = 3;
        const merged = [];
        ops.forEach(([kind], index) => {
          if (kind === 'context') return;
          const start = Math.max(0, index - context);
          const end = Math.min(ops.length, index + context + 1);
          const last = merged[merged.length - 1];
          if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
        });
        let added = 0, removed = 0;
        const hunks = merged.map(([start, end]) => {
          let beforeOld = 0, beforeNew = 0;
          for (const [kind] of ops.slice(0, start)) { if (kind !== 'added') beforeOld++; if (kind !== 'removed') beforeNew++; }
          let ho = beforeOld + 1, hn = beforeNew + 1;
          const lines = ops.slice(start, end).map(([kind, text]) => {
            if (kind === 'context') return { kind, text, oldLine: ho++, newLine: hn++ };
            if (kind === 'added') { added++; return { kind, text, oldLine: null, newLine: hn++ }; }
            removed++; return { kind, text, oldLine: ho++, newLine: null };
          });
          return { oldStart: beforeOld + 1, oldLines: ho - beforeOld - 1, newStart: beforeNew + 1, newLines: hn - beforeNew - 1, lines };
        });
        const canonical = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const summary = { identical: leftText === rightText, newlineOnly: leftText !== rightText && canonical(rawLeft) === canonical(rawRight),
          leftBytes: left.bytes.length, rightBytes: right.bytes.length, leftLines: a.length, rightLines: b.length,
          addedLines: added, removedLines: removed, changedHunks: hunks.length };
        const result = { summary, hunks, provenance: { operation: 'text.compare', leftEncoding: 'auto', rightEncoding: 'auto', newline: mode } };
        const output = this.document('result.diff.json', Buffer.from(JSON.stringify(result, null, 2)), 'json', 'application/json');
        event.summary = JSON.stringify(summary);
        event.resultDocumentId = output.id; event.outputBytes = output.size; event.resultMime = 'application/json';
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
