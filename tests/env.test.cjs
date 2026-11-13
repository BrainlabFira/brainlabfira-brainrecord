const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnv } = require('../dist/main/env');
function isolated(fn) {
  const cwd = process.cwd(), saved = { ...process.env };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrecord-env-'));
  try { process.chdir(folder); fn(folder); }
  finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
test('local URL settings normalize trailing slashes without changing credentials', () => isolated(folder => {
  fs.writeFileSync(path.join(folder, '.env'), [
    'UPLOAD_SERVICE_URL=http://192.168.1.175:9210/  ',
    'TRANSCRIPTOR_API_URL="http://192.168.1.171:18766///"',
    'TRANSCRIPTOR_PUBLIC_URL=http://192.168.1.171:18766/',
    'MINIO_CONSOLE_URL=http://192.168.1.175:9101/',
    'TRANSCRIPTOR_API_KEY=credential-ending-in-/',
  ].join('\n'));
  loadEnv();
  assert.equal(process.env.UPLOAD_SERVICE_URL + '/recordings', 'http://192.168.1.175:9210/recordings');
  assert.equal(process.env.TRANSCRIPTOR_API_URL, 'http://192.168.1.171:18766');
  assert.equal(process.env.TRANSCRIPTOR_PUBLIC_URL, 'http://192.168.1.171:18766');
  assert.equal(process.env.MINIO_CONSOLE_URL, 'http://192.168.1.175:9101');
  assert.equal(process.env.TRANSCRIPTOR_API_KEY, 'credential-ending-in-/');
}));
test('process URL overrides are normalized even without a local env file', () => isolated(() => {
  process.env.UPLOAD_SERVICE_URL = ' http://recordings.internal:9210/// ';
  loadEnv();
  assert.equal(process.env.UPLOAD_SERVICE_URL, 'http://recordings.internal:9210');
}));
