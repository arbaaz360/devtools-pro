import type { SavePresentation, ToolViewRuntime } from './types';
import type { ToolManifest } from '../bridge';
import { defaultSavePresentation } from './types';

export function selectControl(id: string, label: string, operations: Array<{ id: string; label: string }>, selected?: string): HTMLSelectElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'dynamic-option';
  wrapper.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  for (const operation of operations) {
    const option = document.createElement('option');
    option.value = operation.id;
    option.textContent = operation.label;
    option.selected = operation.id === selected;
    select.append(option);
  }
  wrapper.append(select);
  return select;
}

export function actionButton(label: string, disabled: boolean, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary-button';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', run);
  return button;
}

export function activeDocument(runtime: ToolViewRuntime): NonNullable<ToolViewRuntime['document']> | null {
  if (!runtime.document) {
    runtime.fail('Open a document before running this tool.');
    return null;
  }
  return runtime.document;
}

export function standardSave(manifest: ToolManifest, operationId: string, mime: string | null): SavePresentation {
  return defaultSavePresentation(manifest, operationId, mime);
}
