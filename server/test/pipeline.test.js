// Whole server-side recording pipeline: token -> upload -> events -> ended -> transcript with speaker names -> notes.
// OpenAI is replaced by a local fake. Needs MongoDB (MONGODB_URI) like core.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';

let lastListen, listenCalls = 0;
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v1/listen') && req.url.includes('multichannel=true')) {
      listenCalls++;
      lastListen = { url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], bytes: Buffer.concat(chunks).length };
      return res.end(JSON.stringify({ results: { utterances: [
        { start: 1, end: 3, transcript: 'Hello from me.', speaker: 0, channel: 1 },
        { start: 4, end: 7, transcript: 'Hi there, from the other side.', speaker: 0, channel: 0 },
        { start: 9, end: 11, transcript: 'Great, thanks.', speaker: 0, channel: 1 },
      ] } }));
    }
    if (req.url.startsWith('/v1/listen')) {
      listenCalls++;
      lastListen = { url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], bytes: Buffer.concat(chunks).length };
      return res.end(JSON.stringify({ results: { utterances: [
        { start: 1, end: 4, transcript: 'Welcome everyone.', speaker: 0 },
        { start: 4.5, end: 6, transcript: 'Let us begin.', speaker: 0 },
        { start: 9, end: 12, transcript: 'Thanks, sounds good.', speaker: 1 },
        { start: 20, end: 22, transcript: 'Nobody was marked here.', speaker: 1 },
      ] } }));
    }
    if (req.url.endsWith('/audio/transcriptions')) {
      return res.end(JSON.stringify({ text: 'x', segments: [
        { start: 1, end: 4, text: ' Welcome everyone.' },
        { start: 4.5, end: 6, text: ' Let us begin.' },
        { start: 9, end: 12, text: ' Thanks, sounds good.' },
      ] }));
    }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: 'Kickoff', overview: 'A short kickoff.', keyPoints: ['Start'], decisions: [], actionItems: [], chapters: [{ start: 0, title: 'Intro' }], topics: ['kickoff'],
    }) } }] }));
  });
});
await new Promise((r) => fake.listen(0, r));
process.env.OPENAI_API_KEY = 'test-key';
process.env.DEEPGRAM_API_KEY = 'dg-test-key';
process.env.DEEPGRAM_API_URL = `http://127.0.0.1:${fake.address().port}`;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
process.env.FFMPEG_PATH = '/nonexistent/ffmpeg';   // exercise the "send the file as it is" path
process.env.DATA_DIR = path.join(import.meta.dirname, '.tmp-data-pipeline');

const { env } = await import('../src/env.js');
const dbm = await import('../src/db.js');
const { createApi } = await import('../src/api.js');
const { ingest } = await import('../src/ingest.js');

const TEST_DB = 'meeting_assistant_v3_pipeline_test';
let server, base;
before(async () => {
  await dbm.connect(env.mongoUri, TEST_DB);
  await dbm.db.dropDatabase();
  await dbm.close();
  await dbm.connect(env.mongoUri, TEST_DB);
  const app = express();
  app.use('/api', createApi());
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections(); server.close(); fake.close();
  await dbm.db.dropDatabase(); await dbm.close();
  fs.rmSync(env.dataDir, { recursive: true, force: true });
});

const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...o.headers }, body: o.body && JSON.stringify(o.body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('a recording goes from upload token to a transcript with speaker names and notes', async () => {
  const signup = await j('/api/auth/signup', { method: 'POST', body: { name: 'Ada', email: 'ada@example.com', password: 'correct horse', client: 'desktop' } });
  assert.equal(signup.status, 201);
  const auth = { Authorization: `Bearer ${signup.body.token}` };

  const cfg = await j('/api/config');
  assert.equal(cfg.body.recording, true);

  const start = await j('/api/desktop/meetings', { method: 'POST', headers: auth, body: { title: 'Kickoff call', url: 'https://meet.google.com/abc-defg-hij', platform: 'google-meet' } });
  assert.equal(start.status, 200);
  const { meetingId, uploadToken } = start.body;
  assert.ok(uploadToken);

  // Unknown tokens are refused.
  assert.equal((await fetch(`${base}/api/sdk/upload/nope/media`, { method: 'PUT', body: 'x' })).status, 401);

  // Participant events, as the SDK posts them.
  const ev = (event, name, relative) => fetch(`${base}/api/sdk/upload/${uploadToken}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, data: { participant: { id: 1, name }, timestamp: { relative, absolute: new Date().toISOString() } } }),
  });
  for (const [e, n, t] of [['participant_events.join', 'Ana', 0], ['participant_events.join', 'Ben', 0],
    ['participant_events.speech_on', 'Ana', 0.5], ['participant_events.speech_off', 'Ana', 6.5],
    ['participant_events.speech_on', 'Ben', 8.5], ['participant_events.speech_off', 'Ben', 12.5],
    ['participant_events.join', 'You', 0], ['participant_events.speech_on', 'You', 19.5], ['participant_events.speech_off', 'You', 22.5]]) {
    assert.equal((await ev(e, n, t)).status, 200);
  }
  assert.equal((await ev('chat.message', 'Ana', 1)).status, 400);   // only participant events are accepted

  // The recording itself.
  const media = Buffer.alloc(200_000, 7);
  const up = await fetch(`${base}/api/sdk/upload/${uploadToken}/media`, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: media });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).received, media.length);
  assert.equal((await fetch(`${base}/api/sdk/upload/${uploadToken}/media`, { method: 'PUT', body: 'again' })).status, 409);

  const ended = await j(`/api/desktop/meetings/${meetingId}/ended`, {
    method: 'POST', headers: auth,
    body: { participants: [{ id: '1', name: 'Ana', isHost: true }, { id: '2', name: 'Ben' }, { id: '3', name: 'You' }] },
  });
  assert.equal(ended.status, 200);

  await ingest(await dbm.col('meetings').findOne({ _id: meetingId }));

  const m = await j(`/api/meetings/${meetingId}`, { headers: auth });
  assert.equal(m.body.status, 'ready', JSON.stringify(m.body.lastError || m.body.error));
  assert.equal(cfg.body.transcription, 'deepgram');
  assert.equal(lastListen.auth, 'Token dg-test-key');
  assert.match(lastListen.url, /model=nova-3/);
  assert.equal(lastListen.bytes, 200_000);                     // the whole recording was sent
  assert.deepEqual(m.body.segments.map((s) => [s.speaker, s.text]), [
    ['Ana', 'Welcome everyone. Let us begin.'],
    ['Ben', 'Thanks, sounds good.'],
    ['Ada', 'Nobody was marked here.'],                         // marked as "You": the signed-in user's name
  ]);
  assert.deepEqual(m.body.speakers.map((s) => s.name).sort(), ['Ada', 'Ana', 'Ben']);
  assert.equal(m.body.hasVideo, true);
  assert.ok(m.body.mediaUrl);
  assert.equal(m.body.summary.overview, 'A short kickoff.');
});

test('without a Deepgram key the OpenAI fallback transcribes', async () => {
  const saved = env.deepgramKey;
  env.deepgramKey = undefined;
  try {
    const signup = await j('/api/auth/signup', { method: 'POST', body: { name: 'Bo', email: 'bo@example.com', password: 'correct horse', client: 'desktop' } });
    const auth = { Authorization: `Bearer ${signup.body.token}` };
    assert.equal((await j('/api/config')).body.transcription, 'openai');
    const { meetingId, uploadToken } = (await j('/api/desktop/meetings', { method: 'POST', headers: auth, body: { title: 'Fallback', platform: 'zoom' } })).body;
    await fetch(`${base}/api/sdk/upload/${uploadToken}/media`, { method: 'PUT', body: Buffer.alloc(50_000, 3) });
    await j(`/api/desktop/meetings/${meetingId}/ended`, { method: 'POST', headers: auth, body: {} });
    await ingest(await dbm.col('meetings').findOne({ _id: meetingId }));
    const m = await j(`/api/meetings/${meetingId}`, { headers: auth });
    assert.equal(m.body.status, 'ready', String(m.body.lastError));
    assert.deepEqual(m.body.segments.map((x) => [x.speaker, x.text]), [   // no speech markers: unnamed; close segments merge
      ['Speaker', 'Welcome everyone. Let us begin.'], ['Speaker', 'Thanks, sounds good.'],
    ]);
  } finally {
    env.deepgramKey = saved;
  }
});

test('reprocess redoes the transcript and notes from the saved recording', async () => {
  const signup = await j('/api/auth/signup', { method: 'POST', body: { name: 'Cy', email: 'cy@example.com', password: 'correct horse', client: 'desktop' } });
  const auth = { Authorization: `Bearer ${signup.body.token}` };
  const other = await j('/api/auth/signup', { method: 'POST', body: { name: 'Di', email: 'di@example.com', password: 'correct horse' } });
  const { meetingId, uploadToken } = (await j('/api/desktop/meetings', { method: 'POST', headers: auth, body: { title: 'Redo me', platform: 'teams' } })).body;
  const reprocess = (headers = auth) => j(`/api/meetings/${meetingId}/reprocess`, { method: 'POST', headers });

  // Not allowed while recording, or for someone else's meeting.
  assert.equal((await reprocess()).status, 409);
  assert.equal((await reprocess({ Authorization: `Bearer ${other.body.token}` })).status, 404);

  await fetch(`${base}/api/sdk/upload/${uploadToken}/media`, { method: 'PUT', body: Buffer.alloc(30_000, 5) });
  await j(`/api/desktop/meetings/${meetingId}/ended`, { method: 'POST', headers: auth, body: {} });
  await ingest(await dbm.col('meetings').findOne({ _id: meetingId }));
  await dbm.col('meetings').updateOne({ _id: meetingId }, { $set: { 'segments.0.speaker': 'Edited by hand', 'summary.overview': 'Old notes' } });
  const before = listenCalls;

  assert.equal((await reprocess()).status, 202);
  let m;
  for (let i = 0; i < 50; i++) {
    m = (await j(`/api/meetings/${meetingId}`, { headers: auth })).body;
    if (m.status === 'ready' && m.summary?.overview !== 'Old notes' && m.summary) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(m.status, 'ready');
  assert.equal(listenCalls, before + 1);                          // transcribed again
  assert.notEqual(m.segments[0].speaker, 'Edited by hand');        // edits replaced
  assert.equal(m.summary.overview, 'A short kickoff.');            // notes written again

  // A recording whose file is gone cannot be processed again.
  fs.rmSync(path.join(env.dataDir, 'media', `${meetingId}.mp4`));
  assert.equal((await reprocess()).status, 409);
});

test('with ffmpeg the microphone gets its own channel and names follow from it, not from the screen', async () => {
  const fakeFfmpeg = path.join(env.dataDir, 'fake-ffmpeg.sh');
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(fakeFfmpeg, '#!/bin/sh\n[ "$1" = "-version" ] && exit 0\nfor last; do :; done\necho audio > "$last"\nexit 0\n', { mode: 0o755 });
  const saved = env.ffmpeg;
  env.ffmpeg = fakeFfmpeg;
  try {
    const signup = await j('/api/auth/signup', { method: 'POST', body: { name: 'Fitness', email: 'fit@example.com', password: 'correct horse', client: 'desktop' } });
    const auth = { Authorization: `Bearer ${signup.body.token}` };
    const { meetingId, uploadToken } = (await j('/api/desktop/meetings', { method: 'POST', headers: auth, body: { title: 'Two people', platform: 'google-meet' } })).body;
    await fetch(`${base}/api/sdk/upload/${uploadToken}/media`, { method: 'PUT', body: Buffer.alloc(40_000, 9) });
    await j(`/api/desktop/meetings/${meetingId}/ended`, { method: 'POST', headers: auth,
      body: { participants: [{ id: '1', name: 'Yadav' }, { id: '2', name: 'Fitness' }] } });   // no speech markers at all
    await ingest(await dbm.col('meetings').findOne({ _id: meetingId }));
    assert.match(lastListen.url, /multichannel=true/);
    const m = (await j(`/api/meetings/${meetingId}`, { headers: auth })).body;
    assert.equal(m.status, 'ready', String(m.lastError));
    assert.deepEqual(m.segments.map((x) => [x.speaker, x.text]), [
      ['Fitness', 'Hello from me.'], ['Yadav', 'Hi there, from the other side.'], ['Fitness', 'Great, thanks.'],
    ]);
  } finally {
    env.ffmpeg = saved;
  }
});
