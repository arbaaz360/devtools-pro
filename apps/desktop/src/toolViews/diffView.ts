import type { ToolManifest } from '../bridge';
import type { ToolView } from './types';
import { actionButton, standardSave } from './shared';

export const diffView: ToolView = {
  ids: ['text.compare'], group: 'COMPARE', icon: '⇄', sourceMode: 'custom',
  render(runtime) {
    runtime.optionsHost.innerHTML = ''; runtime.actionsHost.innerHTML = ''; runtime.sourceHost.innerHTML = '';
    const state: { left: string | null; right: string | null } = { left: null, right: null };
    const sources = document.createElement('div'); sources.className = 'compare-controls';
    sources.innerHTML = '<div class="compare-heading"><strong>Compare two text documents</strong><span>Files remain read only; pasted text is limited to 256 KiB.</span></div><div class="compare-sources"><section class="compare-source"><div class="compare-source-head"><strong>Left / original</strong><button type="button" class="outline-button" data-side="left" aria-label="Open left comparison file">Open file…</button></div><p class="compare-source-name" data-name="left">No source selected</p><textarea aria-label="Left comparison text" data-paste="left" maxlength="262144" spellcheck="false" wrap="off" placeholder="Or paste up to 256 KiB"></textarea></section><section class="compare-source"><div class="compare-source-head"><strong>Right / revised</strong><button type="button" class="outline-button" data-side="right" aria-label="Open right comparison file">Open file…</button></div><p class="compare-source-name" data-name="right">No source selected</p><textarea aria-label="Right comparison text" data-paste="right" maxlength="262144" spellcheck="false" wrap="off" placeholder="Or paste up to 256 KiB"></textarea></section></div>';
    runtime.sourceHost.append(sources);
    sources.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(button => button.addEventListener('click', async () => { const picked = await runtime.chooseDocument(); if (!picked) return; state[button.dataset.side as 'left' | 'right'] = picked.id; const name = sources.querySelector(`[data-name="${button.dataset.side}"]`); if (name) name.textContent = `${picked.name} · ${runtime.bytes(picked.size)}`; }));
    sources.querySelectorAll<HTMLTextAreaElement>('[data-paste]').forEach(area => area.addEventListener('input', () => { state[area.dataset.paste as 'left' | 'right'] = null; const name = sources.querySelector(`[data-name="${area.dataset.paste}"]`); if (name) name.textContent = area.value.trim() ? 'Pasted text' : 'No source selected'; }));
    const newline = document.createElement('select'); for (const value of ['preserve', 'lf', 'cr_lf', 'ignore']) { const option = document.createElement('option'); option.value = value; option.textContent = value === 'cr_lf' ? 'Normalize CRLF' : value[0].toUpperCase() + value.slice(1); newline.append(option); } newline.id = 'compare-newline'; runtime.optionsHost.append(newline);
    runtime.actionsHost.append(actionButton('Compare documents', runtime.busy, () => void this.run(runtime, JSON.stringify({ state, left: sources.querySelector<HTMLTextAreaElement>('[data-paste="left"]')?.value ?? '', right: sources.querySelector<HTMLTextAreaElement>('[data-paste="right"]')?.value ?? '', newline: newline.value }))));
    (runtime as ToolViewRuntimeWithDiff).diffState = state;
  },
  run(runtime) {
    const extra = runtime as ToolViewRuntimeWithDiff; const state = extra.diffState; if (!state) return;
    const source = runtime.sourceHost.querySelectorAll<HTMLTextAreaElement>('[data-paste]'); const leftText = source[0]?.value ?? ''; const rightText = source[1]?.value ?? '';
    void (async () => { let left = state.left ? runtime.documents.get(state.left) : null; let right = state.right ? runtime.documents.get(state.right) : null; if (!left && leftText.trim()) { left = await runtime.createTextDocument(leftText); state.left = left.id; } if (!right && rightText.trim()) { right = await runtime.createTextDocument(rightText); state.right = right.id; } if (!left || !right) { runtime.fail('Choose or paste both compare sources.'); return; } await runtime.startJob({ documentId: left.id, sourceDocumentId: left.id, toolId: 'text.compare', operationId: 'compare', options: { newline: (runtime.sourceHost.querySelector('#compare-newline') as HTMLSelectElement | null)?.value ?? 'preserve' }, title: `Compare · ${left.name} vs ${right.name}`, status: 'Comparing bounded text…', run: async () => (await import('../bridge')).runCompare(left.id, right.id, { newline: (runtime.sourceHost.querySelector('#compare-newline') as HTMLSelectElement | null)?.value as 'preserve' | 'lf' | 'cr_lf' | 'ignore' }) }); })();
  },
  savePresentation(manifest: ToolManifest, operationId, mime) { return standardSave(manifest, operationId, mime); },
};

interface ToolViewRuntimeWithDiff { diffState?: { left: string | null; right: string | null }; }
