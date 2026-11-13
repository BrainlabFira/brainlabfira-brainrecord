const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { TranscriptionClient, transcriptionSource, transcriptUrl, validateRecording } = require('../dist/main/transcription');
const rec = { userId: '42', fecha: '2026-11-13', recId: 'rec_20261113_103000', chunks: 2, bytes: 1024 };
const jobId = 'a'.repeat(32);
async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}`;
}
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function snapshot(status) { return { job: { id: jobId, status }, percent: status === 'completed' ? 100 : 47, eta_seconds: 24, worker_online: true }; }

test('streams concatenated media, deduplicates clicks, recovers jobs after restart, retries and opens private URL', async t => {
  const video = Buffer.alloc(1024 * 1024, 7);
  let uploads = 0, gets = 0, retries = 0, saved = false, state = 'queued';
  const source = await server(t, (req, res) => {
    gets++;
    assert.equal(req.url, `/concat/42/2026-11-13/rec_20261113_103000?token=employee-token`);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
    res.end(video);
  });
  const api = await server(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer integration-key');
    assert.ok(!req.url.includes('employee-token'));
    if (req.url.endsWith('/retry')) { retries++; state = 'queued'; return json(res, 202, snapshot(state)); }
    if (req.method === 'GET') return json(res, saved ? 200 : 404, saved ? snapshot(state) : { detail: 'missing' });
    uploads++; const chunks = []; for await (const c of req) chunks.push(c);
    assert.deepEqual(Buffer.concat(chunks), video); saved = true;
    json(res, 202, snapshot(state));
  });
  const config = { apiUrl: api, publicUrl: 'http://192.168.1.171:18765', recordingUrl: source, key: 'integration-key' };
  const events = [];
  let client = new TranscriptionClient((actor, recording, s) => events.push(s.status));
  const first = client.start('actor', rec, config, async () => 'employee-token');
  assert.equal(client.start('actor', rec, config, async () => 'employee-token'), first);
  assert.equal((await first).status, 'queued');
  assert.ok(events.includes('preparing')); assert.ok(events.includes('uploading')); assert.ok(events.includes('validating'));
  assert.equal(uploads, 1); assert.equal(gets, 1);
  client = new TranscriptionClient(() => {}); // desktop restart, no local state
  assert.equal((await client.status('actor', rec, config)).jobId, jobId);
  state = 'failed';
  assert.equal((await client.start('actor', rec, config, async () => 'employee-token')).status, 'queued');
  assert.equal(retries, 1); assert.equal(uploads, 1);
  state = 'completed';
  const completed = await client.status('actor', rec, config, true);
  assert.equal(completed.percent, 100);
  assert.equal(transcriptUrl(config, completed.jobId), `http://192.168.1.171:18765/?recording=${jobId}`);
  assert.equal((await client.start('actor', rec, config, async () => 'employee-token')).status, 'completed');
  assert.equal(uploads, 1);
});

test('failed status lookup never uploads, and missing credentials fail clearly', async t => {
  let sourceGets = 0;
  const source = await server(t, (req, res) => { sourceGets++; res.end('unexpected'); });
  const api = await server(t, (req, res) => json(res, 503, { detail: 'processor unavailable' }));
  const client = new TranscriptionClient(() => {});
  const config = { apiUrl: api, publicUrl: api, recordingUrl: source, key: 'integration-key' };
  const state = await client.start('actor', rec, config, async () => 'secret');
  assert.equal(state.status, 'connection_error'); assert.match(state.error, /processor unavailable/);
  assert.equal(sourceGets, 0);
  assert.match((await client.start('actor', rec, { ...config, key: '' }, async () => 'secret')).error, /TRANSCRIPTOR_API_KEY/);
});

test('concat permission failure never submits media; retries can recover', async t => {
  let posts = 0, allowed = false;
  const source = await server(t, (req, res) => { res.writeHead(allowed ? 200 : 403); res.end('video'); });
  const api = await server(t, async (req, res) => {
    if (req.method === 'GET') return json(res, 404, {});
    for await (const chunk of req) {} posts++; json(res, 202, snapshot('queued'));
  });
  const config = { apiUrl: api, publicUrl: api, recordingUrl: source, key: 'key' };
  const client = new TranscriptionClient(() => {});
  assert.match((await client.start('actor', rec, config, async () => 'token')).error, /403/);
  assert.equal(posts, 0);
  allowed = true;
  assert.equal((await client.start('actor', rec, config, async () => 'token')).status, 'queued');
  assert.equal(posts, 1);
});

test('source references separate accounts, changed manifests and servers; reject unsafe paths and link schemes', () => {
  const config = { recordingUrl: 'http://recordings:9210', apiUrl: 'http://api', publicUrl: 'http://private:18765', key: 'key' };
  assert.notEqual(transcriptionSource('a', rec, config), transcriptionSource('b', rec, config));
  assert.notEqual(transcriptionSource('a', rec, config), transcriptionSource('a', { ...rec, chunks: 3 }, config));
  assert.notEqual(transcriptionSource('a', rec, config), transcriptionSource('a', rec, { ...config, recordingUrl: 'http://other' }));
  assert.throws(() => validateRecording({ ...rec, recId: '../secret' }));
  assert.throws(() => validateRecording({ ...rec, bytes: NaN }));
  assert.throws(() => transcriptUrl({ ...config, publicUrl: 'javascript:alert(1)' }, jobId));
  assert.throws(() => transcriptUrl(config, '../secret'));
});
