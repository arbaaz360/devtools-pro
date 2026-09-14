import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultLifecycle } from './resultLifecycle.ts';

test('result lifecycle rejects stale completion after a transition', () => {
  const lifecycle = new ResultLifecycle();
  const first = lifecycle.begin({ toolId: 'structured.json', sourceDocumentId: 'doc-a', operationId: 'format', renderer: 'json' });
  assert.equal(lifecycle.attach(first, 'job-a'), true);
  const token = lifecycle.resultToken('job-a', 'result-a');
  if (!token) throw new Error('expected result token');
  lifecycle.invalidate();
  assert.equal(lifecycle.accepts('job-a'), false);
  assert.equal(lifecycle.isCurrent(token), false);
});

test('a new job can attach only to its own pending transition', () => {
  const lifecycle = new ResultLifecycle();
  const first = lifecycle.begin({ toolId: 'text.url', sourceDocumentId: 'doc-a', operationId: 'encode', renderer: 'text' });
  const second = lifecycle.begin({ toolId: 'text.html', sourceDocumentId: 'doc-a', operationId: 'escape', renderer: 'text' });
  assert.equal(lifecycle.attach(first, 'job-a'), false);
  assert.equal(lifecycle.attach(second, 'job-b'), true);
  assert.equal(lifecycle.accepts('job-a'), false);
  assert.equal(lifecycle.accepts('job-b'), true);
});
