const { spawnSync } = require('child_process');
const cmds = [
  ['node', ['--experimental-strip-types', 'packages/plugin-sdk/scripts/headless.ts', 'plugins', '--plugin', 'text.case', '--input', 'input=userID_loaderHTTPServer v2Api', '--options', '{"target":"snake"}']],
  ['node', ['--experimental-strip-types', 'packages/plugin-sdk/scripts/headless.ts', 'plugins', '--plugin', 'text.case', '--input', 'input=user id', '--options', '{"target":"pascal","acronyms":"ID"}']]
];
for (const [cmd, args] of cmds) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) process.exit(1);
}
