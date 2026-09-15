import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  execFileSync(process.execPath, ['scripts/generate-clipboard-fixture.mjs'], {
    cwd: root, stdio: 'pipe', windowsHide: true,
  });
}
