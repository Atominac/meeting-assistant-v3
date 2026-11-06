import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

process.env.DATA_DIR = path.join(import.meta.dirname, '.tmp-data');

const { env } = await import('../src/env.js');
const dbm = await import('../src/db.js');
const { connect, close, col } = dbm;
const { hashPassword, checkPassword, throttle } = await import('../src/auth.js');
const { normalizeTranscript, speakerStats, toVtt } = await import('../src/transcript.js');
const { createApi } = await import('../src/api.js');
const { mapEvent, findLink } = await import('../src/calendar.js');

const TEST_DB = 'meeting_assistant_v3_test';
let server, base;
before(async () => {
  await connect(env.mongoUri, TEST_DB);
  await dbm.db.dropDatabase(); // leftovers from an interrupted run
  await close();
  await connect(env.mongoUri, TEST_DB); // recreate indexes
  fs.mkdirSync(path.join(env.dataDir, 'media'), { recursive: true });
  const app = express();
  app.set('trust proxy', true);
  app.use('/api', createApi());
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await dbm.db.dropDatabase();
  await close();
  fs.rmSync(env.dataDir, { recursive: true, force: true });
});

const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...o.headers }, body: o.body && JSON.stringify(o.body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test('passwords are salted scrypt hashes and verify correctly', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$/);
  assert.notEqual(h, await hashPassword('correct horse battery')); // random salt
  assert.ok(await checkPassword('correct horse battery', h));
  assert.ok(!(await checkPassword('wrong', h)));
  assert.ok(!(await checkPassword('anything', undefined))); // unknown user path
});

test('throttle blocks after the limit', () => {
  for (let i = 0; i < 3; i++) assert.equal(throttle('t1', 3, 1000), 0);
  assert.ok(throttle('t1', 3, 1000) > 0);
});

test('normalizes word-level transcripts and merges adjacent turns', () => {
  const w = (text, s, e) => ({ text, start_timestamp: { relative: s }, end_timestamp: { relative: e } });
  const segs = normalizeTranscript([
    { participant: { id: 1, name: 'Ada' }, words: [w('Hello', 0, 0.4), w('there', 0.5, 1)] },
    { participant: { id: 1, name: 'Ada' }, words: [w('again.', 1.5, 2)] },
    { participant: { id: 2, name: null }, words: [w('Hi', 3, 3.2)] },
    { participant: { id: 3, name: 'Empty' }, words: [] },
  ]);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { speaker: 'Ada', start: 0, end: 2, text: 'Hello there again.' });
  assert.equal(segs[1].speaker, 'Speaker 2');
  assert.equal(speakerStats(segs)[0].name, 'Ada');
  assert.match(toVtt(segs), /^WEBVTT/);
});

test('extracts meeting links from calendar events', () => {
  assert.equal(findLink('see https://us02web.zoom.us/j/123456789?pwd=x').platform, 'zoom');
  const e = mapEvent({ id: 'e1', summary: 'Sync', start: { dateTime: '2026-10-29T10:00:00Z' }, end: { dateTime: '2026-10-29T10:30:00Z' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', attendees: [{ email: 'a@x.com', self: true }] });
  assert.equal(e.platform, 'meet');
  assert.equal(e.allDay, false);
});

test('sign-up validates input, stores a hash, and rejects duplicates', async () => {
  assert.equal((await j('/api/meetings')).status, 401);
  assert.equal((await j('/api/auth/signup', { method: 'POST', body: { name: 'A', email: 'nope', password: 'longenough1' } })).status, 400);
  assert.equal((await j('/api/auth/signup', { method: 'POST', body: { name: 'A', email: 'a@x.com', password: 'short' } })).status, 400);
  assert.equal((await j('/api/auth/signup', { method: 'POST', body: { name: '', email: 'a@x.com', password: 'longenough1' } })).status, 400);

  const ok = await j('/api/auth/signup', { method: 'POST', body: { name: 'Ada Lovelace', email: '  Ada@Example.COM ', password: 'correct horse' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.email, 'ada@example.com'); // normalised
  assert.ok(ok.body.token);
  const stored = await col('users').findOne({ email: 'ada@example.com' });
  assert.ok(!JSON.stringify(stored).includes('correct horse')); // never stored in the clear
  assert.ok(!JSON.stringify(ok.body).includes('passwordHash'));

  const dup = await j('/api/auth/signup', { method: 'POST', body: { name: 'Other', email: 'ADA@example.com', password: 'another pass1' } });
  assert.equal(dup.status, 409);
});

test('log-in: wrong password and unknown email look the same; right one works for web and desktop', async () => {
  const bad = await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'nope nope nope' } });
  const unknown = await j('/api/auth/login', { method: 'POST', body: { email: 'ghost@example.com', password: 'nope nope nope' } });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.body, unknown.body);

  const web = await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'correct horse' } });
  assert.equal(web.status, 200);
  const desk = await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'correct horse', client: 'desktop', deviceName: 'Ada MacBook' } });
  assert.equal(desk.status, 200);

  const me = await j('/api/auth/me', { headers: bearer(desk.body.token) });
  assert.equal(me.body.user.name, 'Ada Lovelace');
  const sessions = await j('/api/auth/sessions', { headers: bearer(web.body.token) });
  const kinds = sessions.body.items.map((s) => s.kind).sort();
  assert.ok(kinds.includes('desktop') && kinds.includes('web'));
  assert.ok(sessions.body.items.some((s) => s.label === 'Ada MacBook'));
  assert.ok(!JSON.stringify(sessions.body).includes('tokenHash'));
});

test('"ask before recording" defaults on and can be switched per account', async () => {
  const login = await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'correct horse', client: 'desktop' } });
  assert.equal(login.body.user.prefs.askToRecord, true);
  const t = login.body.token;
  assert.equal((await j('/api/auth/prefs', { method: 'PATCH', headers: bearer(t), body: { askToRecord: 'no' } })).status, 400);
  assert.equal((await j('/api/auth/prefs', { method: 'PATCH', headers: bearer(t), body: { askToRecord: false } })).status, 200);
  assert.equal((await j('/api/auth/me', { headers: bearer(t) })).body.user.prefs.askToRecord, false);
  await j('/api/auth/prefs', { method: 'PATCH', headers: bearer(t), body: { askToRecord: true } });
  assert.equal((await j('/api/auth/me', { headers: bearer(t) })).body.user.prefs.askToRecord, true);
});

test('repeated bad passwords get rate limited', async () => {
  let last;
  for (let i = 0; i < 10; i++) last = await j('/api/auth/login', { method: 'POST', body: { email: 'victim@example.com', password: `guess-${i}-xxxx` } });
  assert.equal(last.status, 429);
});

test('logout and revoking a device end that session only; password change signs out the rest', async () => {
  const login = (extra = {}) => j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'correct horse', ...extra } });
  const a = (await login()).body.token, b = (await login({ client: 'desktop' })).body.token, c = (await login()).body.token;

  assert.equal((await j('/api/auth/logout', { method: 'POST', headers: bearer(a) })).status, 200);
  assert.equal((await j('/api/auth/me', { headers: bearer(a) })).status, 401);
  assert.equal((await j('/api/auth/me', { headers: bearer(b) })).status, 200);

  const list = await j('/api/auth/sessions', { headers: bearer(c) });
  const desktop = list.body.items.find((s) => s.kind === 'desktop' && !s.current);
  await j(`/api/auth/sessions/${desktop._id}`, { method: 'DELETE', headers: bearer(c) });
  assert.equal((await j('/api/auth/me', { headers: bearer(b) })).status, 401); // revoked from another device

  const wrong = await j('/api/auth/password', { method: 'POST', headers: bearer(c), body: { current: 'bad bad bad', next: 'brand new pass' } });
  assert.equal(wrong.status, 400);
  const d = (await login()).body.token;
  const change = await j('/api/auth/password', { method: 'POST', headers: bearer(c), body: { current: 'correct horse', next: 'brand new pass' } });
  assert.equal(change.status, 200);
  assert.equal((await j('/api/auth/me', { headers: bearer(c) })).status, 200); // this device stays in
  assert.equal((await j('/api/auth/me', { headers: bearer(d) })).status, 401); // the others are out
  assert.equal((await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'correct horse' } })).status, 401);
  assert.equal((await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'brand new pass' } })).status, 200);
});

test('each account sees only its own meetings; video seeks with Range', async () => {
  const ada = (await j('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'brand new pass' } })).body;
  const bob = (await j('/api/auth/signup', { method: 'POST', body: { name: 'Bob', email: 'bob@example.com', password: 'bobs password' } })).body;

  fs.writeFileSync(path.join(env.dataDir, 'media', 'm1.mp4'), Buffer.from('0123456789'));
  await col('meetings').insertMany([
    { _id: 'm1', uid: ada.user.id, title: 'Planning', status: 'ready', hasVideo: true, startedAt: new Date(), segments: [{ speaker: 'Ada', start: 0, end: 2, text: 'budget approved' }], speakers: [] },
    { _id: 'm2', uid: bob.user.id, title: "Bob's call", status: 'ready', startedAt: new Date(), segments: [] },
  ]);

  const list = await j('/api/meetings', { headers: bearer(ada.token) });
  assert.deepEqual(list.body.items.map((m) => m._id), ['m1']);
  assert.equal(list.body.items[0].segments, undefined);
  assert.equal((await j('/api/meetings?q=budget', { headers: bearer(ada.token) })).body.items.length, 1);
  assert.equal((await j('/api/meetings/m2', { headers: bearer(ada.token) })).status, 404);
  assert.equal((await j('/api/meetings/m1', { method: 'DELETE', headers: bearer(bob.token) })).status, 200); // no-op for Bob
  assert.equal((await j('/api/meetings/m1', { headers: bearer(ada.token) })).status, 200); // still there

  const detail = await j('/api/meetings/m1', { headers: bearer(ada.token) });
  await j('/api/meetings/m1', { method: 'PATCH', headers: bearer(ada.token), body: { rename: { from: 'Ada', to: 'Ada Lovelace' } } });
  assert.equal((await j('/api/meetings/m1', { headers: bearer(ada.token) })).body.segments[0].speaker, 'Ada Lovelace');

  assert.equal(await (await fetch(base + detail.body.mediaUrl)).text(), '0123456789');
  const part = await fetch(base + detail.body.mediaUrl, { headers: { Range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await part.text(), '234');
  assert.equal((await fetch(`${base}/api/media/m1?t=forged.token`)).status, 401);
  assert.match(await fetch(base + '/api/meetings/m1/export?format=txt', { headers: bearer(ada.token) }).then((r) => r.text()), /Ada Lovelace: budget approved/);
});
