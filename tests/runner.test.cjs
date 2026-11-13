const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.resolve('scripts/run.js'), 'utf8');
function run(platform, mode) {
  const calls = [], handlers = {};
  const exit = new Error('exit');
  const mockedProcess = { platform, argv: ['node', 'scripts/run.js', mode], execPath: '/node',
    env: { ELECTRON_RUN_AS_NODE: '1', KEEP: 'value' }, on() {}, exit(status) { calls.push(['exit', status]); throw exit; } };
  const requireMock = name => {
    if (name === 'node:path') return path;
    if (name === 'node:fs') return { cpSync: (...args) => calls.push(['copy', ...args]) };
    if (name === 'electron') return '/electron';
    if (name === 'node:child_process') return {
      spawnSync: (...args) => { calls.push(['sync', ...args]); return { status: 0 }; },
      spawn: (...args) => { calls.push(['spawn', ...args]); return { on(name, fn) { handlers[name] = fn; }, kill() {} }; },
    };
    throw new Error(name);
  };
  requireMock.resolve = () => '/typescript/bin/tsc';
  try { vm.runInNewContext(code, { require: requireMock, process: mockedProcess, __dirname: path.resolve('scripts'), console }); }
  catch (error) { if (error !== exit) throw error; }
  return { calls, handlers, process: mockedProcess };
}
test('Windows delegates to its preserved original commands', () => {
  for (const mode of ['dev', 'build']) {
    const { calls } = run('win32', mode);
    assert.equal(calls[0][1], 'cmd.exe');
    assert.deepEqual(Array.from(calls[0][2]), ['/d', '/s', '/c', `npm run ${mode}:windows`]);
    assert.equal(calls.some(call => call[0] === 'copy'), false);
    assert.equal(calls.at(-1)[1], 0);
  }
  const scripts = require('../package.json').scripts;
  assert.match(scripts['dev:windows'], /xcopy.*set ELECTRON_RUN_AS_NODE=&& electron/);
});
test('Unix builds use native copy and dev launches Electron with the Node override removed', () => {
  for (const platform of ['linux', 'darwin']) {
    const build = run(platform, 'build');
    assert.equal(build.calls[0][1], '/node');
    assert.ok(build.calls.some(call => call[0] === 'copy'));
    assert.equal(build.calls.some(call => call[0] === 'spawn'), false);
    const dev = run(platform, 'dev');
    const launch = dev.calls.find(call => call[0] === 'spawn');
    assert.equal(launch[1], '/electron');
    assert.equal(launch[3].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launch[3].env.KEEP, 'value');
    assert.equal(dev.process.env.ELECTRON_RUN_AS_NODE, '1');
    dev.handlers.exit(7); assert.equal(dev.process.exitCode, 7);
  }
});
