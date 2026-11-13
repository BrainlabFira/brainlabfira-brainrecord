// Run with PLAYWRIGHT_PACKAGE pointing at an installed Playwright package.
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 620 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const listeners = {}, calls = [];
      const rec = { userId: '42', fecha: '2026-11-13', recId: 'rec_20261113_103000', chunks: 2, bytes: 1024, userName: 'Test employee' };
      let state = { status: 'idle' }, finish;
      window.testBridge = { calls, emit(next) { state = next; for (const fn of listeners['transcription:state'] || []) fn({}, { key: JSON.stringify([rec.userId, rec.fecha, rec.recId, rec.chunks, rec.bytes]), state }); }, finish() { finish(state); } };
      window.require = () => ({ ipcRenderer: {
        on(channel, fn) { (listeners[channel] ||= []).push(fn); }, send() {},
        async invoke(channel, data) {
          calls.push({ channel, data });
          const responses = {
            'recording:status': { isRecording: false, recId: null, startedAtMs: 0 },
            'upload:status': { health: 'ok', pending: 0, uploading: 0, uploaded: 0, failed: 0 },
            'config:get': { fps: 5, crf: 28, resolutionScale: .75, captureAudio: true, captureMic: true },
            'session:info': { email: 'test@example.test', numericUserId: 42 },
            'shortcuts:info': { shortcuts: {}, failed: [] }, 'screen:info': { width: 1920, height: 1080 },
            'update:status': { state: 'dev', currentVersion: 'test' },
            'recordings:list': { recordings: [rec], users: [], isAdmin: false },
          };
          if (channel === 'transcription:status') return state;
          if (channel === 'transcription:open') return { ok: true };
          if (channel === 'transcription:start') return new Promise(resolve => { finish = resolve; });
          return responses[channel] ?? false;
        },
      } });
    });
    await page.goto(pathToFileURL(path.resolve('src/renderer/dashboard.html')).toString());
    await page.locator('#tabLibrary').click();
    const button = page.locator('[data-act="transcribe"]');
    await button.waitFor();
    assert.match(await button.innerText(), /Transcribir con IA/);
    await button.click(); assert.equal(await button.isDisabled(), true);
    await page.evaluate(() => testBridge.emit({ status: 'uploading', percent: 38 }));
    assert.match(await button.innerText(), /38%/);
    await page.evaluate(() => testBridge.emit({ status: 'running', percent: 47, eta_seconds: 125, worker_online: true }));
    assert.match(await button.innerText(), /47%/); assert.match(await button.innerText(), /3 min/);
    assert.equal(await button.locator('.ai-fill').evaluate(el => el.style.width), '47%');
    await page.screenshot({ path: '/tmp/brainrecord-transcribing.png' });
    await page.evaluate(() => { testBridge.emit({ status: 'completed', percent: 100 }); testBridge.finish(); });
    await page.waitForFunction(() => document.querySelector('[data-act="transcribe"]').disabled === false);
    assert.match(await button.innerText(), /Abrir transcripción/);
    await button.click();
    const calls = await page.evaluate(() => testBridge.calls.map(c => c.channel));
    assert.equal(calls.filter(c => c === 'transcription:start').length, 1);
    assert.equal(calls.filter(c => c === 'transcription:open').length, 1);
    assert.equal(calls.filter(c => c === 'recordings:play').length, 0);
    await page.locator('[data-act="view"]').click();
    await page.locator('[data-act="download"]').click();
    assert.ok(await page.evaluate(() => testBridge.calls.some(c => c.channel === 'recordings:play')));
    assert.ok(await page.evaluate(() => testBridge.calls.some(c => c.channel === 'recordings:open' && c.data.download)));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => testBridge.emit({ status: 'preparing' }));
    assert.equal(await button.locator('.ai-fill').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.evaluate(() => testBridge.emit({ status: 'connection_error', error: 'Server unavailable' }));
    assert.equal(await button.isDisabled(), false);
    assert.match(await button.getAttribute('title'), /Server unavailable/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS: real dashboard, upload/progress/ETA/completion/open, existing actions, retry, reduced motion and layout; screenshot /tmp/brainrecord-transcribing.png');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
