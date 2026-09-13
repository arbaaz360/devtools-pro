const input = document.querySelector('#input');
const output = document.querySelector('#output');
const tableOutput = document.querySelector('#table-output');
const inputTree = document.querySelector('#input-tree');
const resultState = document.querySelector('#result-state');
const outputMeta = document.querySelector('#output-meta');
const palette = document.querySelector('#palette');
const paletteInput = document.querySelector('#palette-input');

function run(mode = 'format') {
  try {
    const value = JSON.parse(input.value);
    const text = mode === 'minify' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    output.textContent = text;
    outputMeta.textContent = mode === 'minify' ? 'Minified JSON' : 'Formatted JSON';
    resultState.innerHTML = '<span class="success-icon">✓</span> Valid JSON';
    document.querySelector('#last-run').textContent = 'Just now';
    if (tableOutput.dataset.active === 'true') renderTable(value);
  } catch (error) {
    output.textContent = error.message;
    outputMeta.textContent = 'Diagnostics';
    resultState.innerHTML = '<span style="color:#ef9d9d">●</span> Invalid JSON';
  }
}
function renderTable(value) {
  if (!value || typeof value !== 'object') { tableOutput.innerHTML = '<p class="muted">Table view needs an object or array.</p>'; return; }
  const rows = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  tableOutput.innerHTML = `<table><tbody>${rows.map(([key,val]) => `<tr><td>${key}</td><td>${typeof val === 'object' ? JSON.stringify(val) : String(val)}</td></tr>`).join('')}</tbody></table>`;
}
function openPalette() { palette.classList.remove('hidden'); paletteInput.value = ''; paletteInput.focus(); }
function closePalette() { palette.classList.add('hidden'); }
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); }
  if (event.key === 'Escape') closePalette();
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run('format');
});
document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.action;
  if (action === 'copy') navigator.clipboard?.writeText(output.textContent);
  else run(action);
}));
document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => {
  const command = button.dataset.command;
  if (command === 'open-palette') openPalette(); else { closePalette(); if (command === 'copy') navigator.clipboard?.writeText(output.textContent); else run(command); }
}));
document.querySelectorAll('[data-output-view]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-output-view]').forEach((b) => b.classList.remove('active')); button.classList.add('active');
  const table = button.dataset.outputView === 'table'; tableOutput.dataset.active = table ? 'true' : 'false'; output.classList.toggle('hidden', table); tableOutput.classList.toggle('hidden', !table); if (table) renderTable(JSON.parse(input.value));
}));
document.querySelectorAll('.input-pane [data-view]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.input-pane [data-view]').forEach((b) => b.classList.remove('active')); button.classList.add('active');
  const tree = button.dataset.view === 'tree'; input.classList.toggle('hidden', tree); document.querySelector('.line-numbers').classList.toggle('hidden', tree); inputTree.classList.toggle('hidden', !tree);
  if (tree) { try { inputTree.textContent = JSON.stringify(JSON.parse(input.value), null, 2); } catch (e) { inputTree.textContent = `Unable to build tree: ${e.message}`; } }
}));
paletteInput.addEventListener('input', () => { const q = paletteInput.value.toLowerCase(); document.querySelectorAll('.command-list button').forEach((button) => { button.hidden = !button.textContent.toLowerCase().includes(q); }); });
palette.addEventListener('click', (event) => { if (event.target === palette) closePalette(); });
run();
