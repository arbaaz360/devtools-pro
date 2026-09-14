import type { ToolManifest } from '../bridge';
import type { ToolView } from './types';
import { actionButton, activeDocument, standardSave } from './shared';

function imageView(id: 'encoding.image-base64' | 'encoding.base64-image', label: string, operation: 'encode' | 'decode'): ToolView {
  return {
    ids: [id], group: 'TEXT & ENCODING', icon: '#',
    render(runtime) { runtime.optionsHost.innerHTML = ''; runtime.actionsHost.innerHTML = ''; runtime.actionsHost.append(actionButton(label, runtime.busy || !runtime.document, () => void this.run(runtime, operation))); },
    run(runtime) { const document = activeDocument(runtime); if (!document) return; void runtime.startJob({ documentId: document.id, toolId: id, operationId: operation, options: operation === 'encode' ? { dataUri: true } : {}, title: `${label} · ${document.name}`, status: 'Processing complete file…' }); },
    savePresentation(manifest: ToolManifest, operationId, mime) { return { ...standardSave(manifest, operationId, mime), suffix: operation === 'decode' ? `.decoded.${mime === 'image/jpeg' ? 'jpg' : 'png'}` : '.base64.txt', label: operation === 'decode' ? 'Save decoded image…' : 'Save Base64…', filterName: operation === 'decode' ? 'Image' : 'Text', extensions: operation === 'decode' ? ['png', 'jpg', 'jpeg'] : ['txt'] }; },
  };
}

export const imageToBase64View = imageView('encoding.image-base64', 'Image → Base64', 'encode');
export const base64ToImageView = imageView('encoding.base64-image', 'Base64 → Image', 'decode');
