import type { ToolManifest } from '../bridge';
import type { ToolView } from './types';
import { actionButton, activeDocument, selectControl, standardSave } from './shared';

export const textView: ToolView = {
  ids: ['text.url', 'text.html', 'text.unicode'], group: 'TEXT & ENCODING', icon: 'Aa',
  render(runtime) {
    runtime.optionsHost.innerHTML = ''; runtime.actionsHost.innerHTML = '';
    const select = selectControl('text-operation', 'Operation', runtime.manifest.operations);
    runtime.optionsHost.append(select.parentElement!);
    runtime.actionsHost.append(actionButton('Run utility', runtime.busy || !runtime.document, () => void this.run(runtime, select.value)));
  },
  run(runtime, operationId) {
    const document = activeDocument(runtime); if (!document) return;
    if (document.format !== 'text') { runtime.fail('Text utilities require a text document.'); return; }
    void runtime.startJob({ documentId: document.id, toolId: runtime.manifest.id, operationId, title: `${operationId[0].toUpperCase()}${operationId.slice(1)} · ${document.name}`, status: 'Transforming complete file…' });
  },
  savePresentation(manifest: ToolManifest, operationId, mime) { return standardSave(manifest, operationId, mime); },
};
