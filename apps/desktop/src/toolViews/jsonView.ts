import type { ToolManifest } from '../bridge';
import type { ToolView } from './types';
import { actionButton, activeDocument, selectControl, standardSave } from './shared';

export const jsonView: ToolView = {
  ids: ['structured.json', 'structured.csv', 'text.inspect'],
  group: 'STRUCTURED DATA',
  icon: '{}',
  render(runtime) {
    runtime.optionsHost.innerHTML = '';
    runtime.actionsHost.innerHTML = '';
    const select = selectControl('input-format', 'Input type', [], runtime.document?.format ?? 'json');
    if (runtime.manifest.id === 'structured.json' || runtime.manifest.id === 'structured.csv') {
      select.innerHTML = '';
      for (const value of ['json', 'csv', 'text']) {
        const option = document.createElement('option'); option.value = value; option.textContent = value.toUpperCase(); option.selected = runtime.document?.format === value;
        select.append(option);
      }
    }
    if (runtime.manifest.id === 'structured.json' || runtime.manifest.id === 'structured.csv') runtime.optionsHost.append(select.parentElement!);
    for (const operation of runtime.manifest.operations) {
      runtime.actionsHost.append(actionButton(operation.label, runtime.busy || !runtime.document, () => void this.run(runtime, operation.id)));
    }
  },
  run(runtime, operationId) {
    const document = activeDocument(runtime); if (!document) return;
    if (operationId !== 'inspect' && document.format !== 'json') { runtime.fail('Formatting and minifying currently support JSON documents only.'); return; }
    void runtime.startJob({ documentId: document.id, toolId: runtime.manifest.id, operationId, title: `${operationId[0].toUpperCase()}${operationId.slice(1)} · ${document.name}`, status: `${operationId[0].toUpperCase()}${operationId.slice(1)}ing complete file…` });
  },
  savePresentation(manifest: ToolManifest, operationId, mime) { return standardSave(manifest, operationId, mime); },
};
