// Targets only a disposable API container. Never point this at production.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { TranscriptionClient, transcriptUrl } = require('../dist/main/transcription');
(async () => {
  const apiUrl = process.env.TRANSCRIPTOR_TEST_API_URL;
  if (!apiUrl || !process.env.TRANSCRIPTOR_TEST_API_KEY) throw new Error('Set disposable TRANSCRIPTOR_TEST_API_URL and TRANSCRIPTOR_TEST_API_KEY');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrecord-e2e-'));
  const source = http.createServer();
  try {
    const video = path.join(folder, 'synthetic.mp4');
    const result = spawnSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=5:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
    const bytes = fs.readFileSync(video);
    source.on('request', (req, res) => {
      assert.equal(new URL(req.url, 'http://source').searchParams.get('token'), 'synthetic-session');
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); fs.createReadStream(video).pipe(res);
    });
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    const config = { apiUrl, publicUrl: apiUrl, recordingUrl: `http://127.0.0.1:${source.address().port}`, key: process.env.TRANSCRIPTOR_TEST_API_KEY };
    const rec = { userId: 'test', fecha: '2026-11-13', recId: 'rec_test', chunks: 1, bytes: bytes.length };
    const client = new TranscriptionClient(() => {});
    const queued = await client.start('synthetic-user', rec, config, async () => 'synthetic-session');
    assert.equal(queued.status, 'queued', JSON.stringify(queued));
    const job = await (await fetch(`${apiUrl}/api/jobs/${queued.jobId}`)).json();
    assert.equal(job.info.audio, true); assert.ok(job.info.duration > 0); assert.equal(job.info.total_sections, 1);
    assert.equal((await (await fetch(`${apiUrl}/api/jobs/${job.id}/media`)).arrayBuffer()).byteLength, bytes.length);
    // A new client must recover the same job without uploading again.
    const recovered = await new TranscriptionClient(() => {}).status('synthetic-user', rec, config);
    assert.equal(recovered.jobId, job.id);
    const page = await fetch(transcriptUrl(config, job.id)); assert.equal(page.status, 200);
    await fetch(`${apiUrl}/api/jobs/${job.id}/cancel`, { method: 'POST' });
    const deleted = await fetch(`${apiUrl}/api/jobs/${job.id}`, { method: 'DELETE' }); assert.equal(deleted.status, 204);
    console.log('PASS: generated MP4+AAC → authenticated source stream → real FastAPI media inspection/queue → persisted lookup → recording page → cleanup');
  } finally { source.closeAllConnections(); source.close(); fs.rmSync(folder, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
