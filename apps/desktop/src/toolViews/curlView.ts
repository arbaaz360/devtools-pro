import type { ToolManifest } from '../bridge';
import type { ToolView } from './types';
import { actionButton, standardSave } from './shared';

export const curlView: ToolView = {
  ids: ['web.curl-code'], group: 'WEB & API', icon: '↗', sourceMode: 'custom',
  render(runtime) {
    runtime.optionsHost.innerHTML = ''; runtime.actionsHost.innerHTML = ''; runtime.sourceHost.innerHTML = '';
    const input = document.createElement('textarea'); input.className = 'curl-input'; input.id = 'curl-input'; input.spellcheck = false; input.wrap = 'off'; input.placeholder = "curl https://api.example.com/data\n  -H 'Accept: application/json'\n  --json '{\"hello\":\"world\"}'"; input.setAttribute('aria-label', 'cURL command input'); runtime.sourceHost.append(input);
    const target = document.createElement('select'); target.id = 'curl-target'; for (const [value, text] of [['fetch', 'JavaScript fetch'], ['python', 'Python requests']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; target.append(option); } runtime.optionsHost.append(target);
    runtime.actionsHost.append(actionButton('Generate code', runtime.busy, () => void this.run(runtime, target.value)));
  },
  run(runtime, operationId) {
    const input = runtime.sourceHost.querySelector<HTMLTextAreaElement>('#curl-input'); const text = input?.value.trim() ?? ''; if (!text) { runtime.fail('Paste a cURL command first.'); return; }
    void (async () => { const document = await runtime.createTextDocument(text); runtime.setActiveDocument(document.id); await runtime.startJob({ documentId: document.id, toolId: 'web.curl-code', operationId, title: `Generate ${operationId} · cURL`, status: 'Generating code locally…' }); })();
  },
  savePresentation(manifest: ToolManifest, operationId, mime) { return standardSave(manifest, operationId, mime); },
};
