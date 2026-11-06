// Recording commands. A real capture needs the Screen Recording permission for the process running the tests:
// when it is missing the test checks the refusal; when it is granted the test records 4 seconds of desktop
// audio and checks that the file reaches the mock server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sdk = createRequire(import.meta.url)('../packages/sdk');
const skip = process.platform !== 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('recording commands', { skip, timeout: 60000 }, async () => {
  const PORT = 4019;
  const server = spawn(process.execPath, [path.resolve(import.meta.dirname, '../mock-server/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(600);
  const base = `http://localhost:${PORT}`;
  const { upload_token: token, id: uploadId } = await (await fetch(`${base}/api/v1/sdk-upload`, { method: 'POST' })).json();

  const events = [];
  for (const t of ['recording-started', 'recording-ended', 'media-capture-status', 'permission-status', 'error']) {
    sdk.addEventListener(t, (e) => events.push([t, e]));
  }
  try {
    await sdk.init({ apiUrl: base, dev: true, disableDetection: true });
    const screen = events.find(([t, e]) => t === 'permission-status' && e.permission === 'screen-capture')[1];

    await assert.rejects(sdk.startRecording({ windowId: 'nope', uploadToken: token }), /permission|Unknown window/);
    await assert.rejects(sdk.sendChatMessage({ windowId: 'x', message: 'hi' }), /Raw Media/);
    assert.equal(await sdk.pauseRecording({ windowId: 'unknown' }), null);
    assert.equal(await sdk.uploadRecording({ windowId: 'unknown' }), null);
    const source = await sdk.prepareDesktopAudioRecording();
    assert.match(source, /^desktop-/);

    if (!screen.granted) {
      await assert.rejects(sdk.startRecording({ windowId: source, uploadToken: token }), /screen-capture permission/);
      return;
    }

    await sdk.startRecording({ windowId: source, uploadToken: token });
    await sleep(4000);
    await sdk.stopRecording({ windowId: source });
    await sleep(3000);
    const names = events.map(([t]) => t);
    assert.ok(names.includes('recording-started'), `events: ${JSON.stringify(names)}`);
    assert.ok(names.includes('recording-ended'));
    const stored = path.resolve(import.meta.dirname, '../data/uploads', uploadId, 'recording.part');
    assert.ok(fs.existsSync(stored) && fs.statSync(stored).size > 1000, 'recording reached the mock server');
  } finally {
    await sdk.shutdown().catch(() => {});
    server.kill();
  }
});

test('participant events are sent as JSON (the server ignores bodies without the content type)', { skip }, async () => {
  const http = await import('node:http');
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, type: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise((r) => fake.listen(0, r));
  try {
    await sdk.init({ apiUrl: 'https://api.example.com', disableDetection: true });
    const status = await sdk._debug('debugPostEvent', { apiUrl: `http://127.0.0.1:${fake.address().port}/api/sdk`, token: 'tok123' });
    assert.equal(status, 200);
    assert.equal(seen[0].url, '/api/sdk/upload/tok123/events');
    assert.equal(seen[0].type, 'application/json');
    assert.equal(JSON.parse(seen[0].body).data.participant.name, 'Test');
  } finally {
    await sdk.shutdown().catch(() => {});
    fake.close();
  }
});
