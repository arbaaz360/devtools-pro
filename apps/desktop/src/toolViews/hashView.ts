import type { ToolManifest } from '../bridge';
import type { ToolView } from './types';
import { actionButton, activeDocument, selectControl, standardSave } from './shared';

export const hashView: ToolView = {
  ids: ['encoding.hash'], group: 'TEXT & ENCODING', icon: '#',
  render(runtime) {
    runtime.optionsHost.innerHTML = ''; runtime.actionsHost.innerHTML = '';
    const select = selectControl('hash-algorithm', 'Algorithm', runtime.manifest.operations);
    runtime.optionsHost.append(select.parentElement!);
    runtime.actionsHost.append(actionButton('Generate hash', runtime.busy || !runtime.document, () => void this.run(runtime, select.value)));
  },
  run(runtime, operationId) { const document = activeDocument(runtime); if (!document) return; void runtime.startJob({ documentId: document.id, toolId: runtime.manifest.id, operationId, title: `${operationId.toUpperCase()} · ${document.name}`, status: 'Hashing complete file…' }); },
  savePresentation(manifest: ToolManifest, operationId, mime) { return { ...standardSave(manifest, operationId, mime), suffix: '.sha.txt', label: 'Save hash…', filterName: 'Text', extensions: ['txt'] }; },
};
