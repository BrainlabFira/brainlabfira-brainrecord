// Windows keeps its original commands; Unix uses native copy and environment APIs.
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2] || 'dev';
if (process.platform === 'win32' && mode !== 'native') {
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `npm run ${mode}:windows`], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const build = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
fs.cpSync(path.join(__dirname, '../src/renderer'), path.join(__dirname, '../dist/renderer'), { recursive: true });
if (mode === 'build') process.exit(0);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
