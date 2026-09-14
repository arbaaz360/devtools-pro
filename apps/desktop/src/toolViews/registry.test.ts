import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolViewRegistry } from './registry.ts';
import type { ToolView } from './types.ts';
import type { ToolManifest } from '../bridge.ts';

const view: ToolView = { ids: ['test.tool'], group: 'TEST', icon: 'T', render() {}, run() {}, savePresentation: () => ({ title: 'Save', suffix: '.txt', label: 'Save', savedStatus: 'Saved', filterName: 'Text', extensions: ['txt'] }) };
const manifest: ToolManifest = { id: 'test.tool', label: 'Test tool', contractVersion: 1, inputKinds: ['text'], limits: { maxInputBytes: null, maxOutputBytes: null }, capabilities: { deterministic: true, supportsPreview: true, supportsStreaming: false, cancellation: true, progress: false, needsFilesystem: false, needsNetwork: false, needsSecrets: false }, operations: [{ id: 'run', label: 'Run', defaultOptions: {} }], renderer: 'text' };

test('registry resolves a manifest to its isolated view', () => {
  const registry = new ToolViewRegistry().register(view);
  assert.equal(registry.has('test.tool'), true);
  assert.equal(registry.resolve(manifest).view, view);
});

test('unknown manifests resolve safely as unavailable', () => {
  const registry = new ToolViewRegistry();
  assert.equal(registry.resolve({ ...manifest, id: 'missing.tool' }).view, null);
});
