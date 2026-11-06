import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { col } from './db.js';
import { env } from './env.js';
import { requireUser, sign, verify, hashPassword, checkPassword, createSession, publicUser, normEmail, validEmail, passwordProblem, throttle, clearThrottle } from './auth.js';
import { createUpload, attachUploadRoutes, recordingConfigured, realName } from './recording.js';
import { cleanTitle } from './titles.js';
import { ingest, mediaPath, runSummary } from './ingest.js';
import { TEMPLATES, publicTemplates } from './templates.js';
import { transcriptionProvider } from './transcribe.js';
import { aiConfigured, buildContext, streamChat } from './ai.js';
import { authUrl, calendarConfigured, handleCallback, matchEvent, syncCalendar } from './calendar.js';
import { toText, toVtt, toSrt, buildSpeakers } from './transcript.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// The desktop app reports who is in the call; keep only what we show.
const cleanParticipants = (list, me) => Array.isArray(list)
  ? list.slice(0, 500).map((p) => ({ id: String(p.id ?? '').slice(0, 80), name: realName(p.name, me), isHost: !!p.isHost, joinedAt: p.joinedAt || null, leftAt: p.leftAt || null })).filter((p) => p.name)
  : null;
const LIST_FIELDS = { segments: 0, 'summary.keyPoints': 0, 'summary.decisions': 0, 'summary.actionItems': 0, 'summary.chapters': 0 };

export function createApi() {
  const r = express.Router();

  // Upload endpoints used by the desktop SDK; registered before express.json() because the media body is a raw stream.
  attachUploadRoutes(r);

  r.use(express.json({ limit: '2mb' }));

  // ---------- config + accounts ----------
  r.get('/config', (_req, res) => res.json({ recording: recordingConfigured(), transcription: transcriptionProvider(), ai: aiConfigured(), calendar: calendarConfigured(), templates: publicTemplates(), inviteRequired: !!env.signupCode }));

  const ipOf = (req) => req.ip || req.socket.remoteAddress || '';
  const loginResult = async (user, kind, label) => ({
    token: await createSession(user, { kind, label }), user: publicUser(user),
  });
  const kindOf = (b) => (b?.client === 'desktop' ? 'desktop' : 'web');

  r.post('/auth/signup', wrap(async (req, res) => {
    const { password, inviteCode, deviceName } = req.body || {};
    const email = normEmail(req.body?.email), name = String(req.body?.name || '').trim().slice(0, 80);
    const wait = throttle(`signup:${ipOf(req)}`, 10, 60 * 60_000);
    if (wait) return res.status(429).json({ error: `Too many sign-ups from here. Try again in ${wait} min.` });
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const bad = passwordProblem(password);
    if (bad) return res.status(400).json({ error: bad });
    if (env.signupCode && String(inviteCode || '').trim() !== env.signupCode) return res.status(403).json({ error: 'That invite code is not right.' });
    const user = { _id: crypto.randomUUID(), name, email, passwordHash: await hashPassword(password), createdAt: new Date() };
    try { await col('users').insertOne(user); } catch (e) {
      if (e.code === 11000) return res.status(409).json({ error: 'An account with that email already exists. Log in instead.' });
      throw e;
    }
    res.status(201).json(await loginResult(user, kindOf(req.body), deviceName));
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const email = normEmail(req.body?.email), { password, deviceName } = req.body || {};
    const key = `login:${ipOf(req)}:${email}`;
    const wait = throttle(key);
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait} min.` });
    const user = await col('users').findOne({ email });
    const ok = await checkPassword(String(password || ''), user?.passwordHash); // same work whether or not the email exists
    if (!user || !ok) return res.status(401).json({ error: 'Email or password is not right.' });
    clearThrottle(key);
    res.json(await loginResult(user, kindOf(req.body), deviceName));
  }));

  // ---------- media (signed URL so <video> can seek without headers) ----------
  r.get('/media/:id', wrap(async (req, res) => {
    const p = verify(req.query.t);
    if (!p || p.m !== req.params.id) return res.status(401).end();
    const file = mediaPath(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).end();
    const size = fs.statSync(file).size;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (!range) { res.setHeader('Content-Length', size); return fs.createReadStream(file).pipe(res); }
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  }));

  // ---------- calendar OAuth callback (browser redirect, no bearer header) ----------
  r.get('/calendar/google/callback', async (req, res) => {
    let msg = { type: 'calendar-connected' };
    try { msg.email = await handleCallback(String(req.query.code || ''), String(req.query.state || '')); }
    catch (e) { msg = { type: 'calendar-error', error: e.message }; }
    res.type('html').send(`<!doctype html><meta charset=utf-8><title>Calendar</title><body style="font:16px -apple-system,system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>${msg.error ? 'Could not connect: ' + msg.error.replace(/[<>&]/g, '') : 'Calendar connected. You can close this window.'}</p><script>try{window.opener&&window.opener.postMessage(${JSON.stringify(msg).replace(/</g, '\\u003c')},'*')}catch(e){};setTimeout(()=>window.close(),${msg.error ? 60000 : 800})</script>`);
  });

  // ---------- everything below needs a signed-in session (web or desktop) ----------
  r.use(requireUser);

  r.get('/auth/me', (req, res) => res.json({ user: { id: req.user.uid, name: req.user.name, email: req.user.email, prefs: req.user.prefs }, session: req.session._id}));
  r.post('/auth/logout', wrap(async (req, res) => { await col('sessions').deleteOne({ _id: req.session._id }); res.json({ ok: true }); }));
  r.patch('/auth/me', wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    await col('users').updateOne({ _id: req.user.uid }, { $set: { name } });
    res.json({ ok: true });
  }));
  r.patch('/auth/prefs', wrap(async (req, res) => {
    const { askToRecord, summaryTemplate } = req.body || {};
    const set = {};
    if (askToRecord !== undefined) {
      if (typeof askToRecord !== 'boolean') return res.status(400).json({ error: 'askToRecord must be true or false.' });
      set['prefs.askToRecord'] = askToRecord;
    }
    if (summaryTemplate !== undefined) {
      if (!TEMPLATES.some((t) => t.id === summaryTemplate)) return res.status(400).json({ error: 'Unknown summary template.' });
      set['prefs.summaryTemplate'] = summaryTemplate;
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change.' });
    await col('users').updateOne({ _id: req.user.uid }, { $set: set });
    res.json({ ok: true });
  }));
  r.post('/auth/password', wrap(async (req, res) => {
    const { current, next } = req.body || {};
    const wait = throttle(`pw:${req.user.uid}`, 6);
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait} min.` });
    const u = await col('users').findOne({ _id: req.user.uid });
    if (!(await checkPassword(String(current || ''), u.passwordHash))) return res.status(400).json({ error: 'Your current password is not right.' });
    const bad = passwordProblem(next);
    if (bad) return res.status(400).json({ error: bad });
    await col('users').updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(next) } });
    // changing the password signs out every other device
    await col('sessions').deleteMany({ uid: u._id, _id: { $ne: req.session._id } });
    res.json({ ok: true });
  }));
  r.get('/auth/sessions', wrap(async (req, res) => {
    const items = await col('sessions').find({ uid: req.user.uid }, { projection: { tokenHash: 0 } }).sort({ lastSeenAt: -1 }).toArray();
    res.json({ items: items.map((s) => ({ ...s, current: s._id === req.session._id })) });
  }));
  r.delete('/auth/sessions/:id', wrap(async (req, res) => { await col('sessions').deleteOne({ _id: req.params.id, uid: req.user.uid }); res.json({ ok: true }); }));

  // ---------- desktop app ----------
  r.get('/desktop/upcoming', wrap(async (req, res) => {
    const events = await col('calendar_events').find({
      uid: req.user.uid, allDay: false, end: { $gte: new Date() }, start: { $lte: new Date(Date.now() + 12 * 3600_000) },
    }).sort({ start: 1 }).limit(8).project({ title: 1, start: 1, end: 1, platform: 1, url: 1 }).toArray();
    res.json({ events });
  }));

  r.post('/desktop/meetings', wrap(async (req, res) => {
    if (!recordingConfigured()) return res.status(503).json({ error: 'Recording is not set up on the server' });
    const { title, url, platform } = req.body;
    const ev = await matchEvent(req.user, { url, platform });
    const callTitle = cleanTitle(title);
    const _id = crypto.randomUUID();
    const upload = await createUpload({ meetingId: _id, uid: req.user.uid, userName: req.user.name });
    const doc = {
      _id, uid: req.user.uid, userName: req.user.name, sessionId: req.session._id,
      title: ev?.title || callTitle || 'Meeting', titleLocked: !!(ev || callTitle), platform: platform || ev?.platform || 'unknown', url: url || ev?.url || null,
      calendarEventId: ev?.eventId || null, attendees: ev?.attendees || [], status: 'recording', startedAt: new Date(), uploadId: upload.id,
    };
    await col('meetings').insertOne(doc);
    res.json({ meetingId: _id, uploadToken: upload.upload_token, title: doc.title, calendarMatched: !!ev });
  }));

  // The call's title can resolve after recording starts (and sometimes only at the end), so the app reports it as it learns it.
  const setCallTitle = async (req) => {
    const people = cleanParticipants(req.body?.participants, req.user.name);
    if (people) await col('meetings').updateOne({ _id: req.params.id, uid: req.user.uid }, { $set: { participants: people } });
    const t = cleanTitle(req.body?.title);
    if (t) await col('meetings').updateOne({ _id: req.params.id, uid: req.user.uid, calendarEventId: null }, { $set: { title: t, titleLocked: true } });
  };
  r.patch('/desktop/meetings/:id', wrap(async (req, res) => { await setCallTitle(req); res.json({ ok: true }); }));
  r.post('/desktop/meetings/:id/ended', wrap(async (req, res) => {
    await setCallTitle(req);
    await col('meetings').updateOne({ _id: req.params.id, uid: req.user.uid, status: 'recording' }, { $set: { status: 'processing', endedAt: new Date() } });
    res.json({ ok: true });
  }));

  r.get('/meetings', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const filter = { uid: req.user.uid };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: rx }, { 'summary.overview': rx }, { 'summary.topics': rx }, { 'segments.text': rx }, { 'speakers.name': rx }];
    }
    const items = await col('meetings').find(filter, { projection: LIST_FIELDS }).sort({ startedAt: -1 }).limit(200).toArray();
    res.json({ items });
  }));

  r.get('/meetings/:id', wrap(async (req, res) => {
    const m = await col('meetings').findOne({ _id: req.params.id, uid: req.user.uid });
    if (!m) return res.status(404).json({ error: 'Not found' });
    m.mediaUrl = m.hasVideo ? `/api/media/${m._id}?t=${sign({ m: m._id }, 7200)}` : null;
    res.json(m);
  }));

  r.patch('/meetings/:id', wrap(async (req, res) => {
    const m = await col('meetings').findOne({ _id: req.params.id, uid: req.user.uid });
    if (!m) return res.status(404).json({ error: 'Not found' });
    const set = {};
    if (typeof req.body.title === 'string' && req.body.title.trim()) { set.title = req.body.title.trim().slice(0, 200); set.titleLocked = true; }
    const { from, to } = req.body.rename || {};
    if (from && to?.trim()) {
      set.segments = (m.segments || []).map((s) => (s.speaker === from ? { ...s, speaker: to.trim() } : s));
      if (m.participants?.length) set.participants = m.participants.map((p) => (p.name === from ? { ...p, name: to.trim() } : p));
      set.speakers = buildSpeakers(set.participants || m.participants, set.segments);
    }
    await col('meetings').updateOne({ _id: m._id }, { $set: set });
    res.json({ ok: true });
  }));

  r.delete('/meetings/:id', wrap(async (req, res) => {
    const out = await col('meetings').deleteOne({ _id: req.params.id, uid: req.user.uid });
    if (out.deletedCount) fs.rm(mediaPath(req.params.id), () => {});
    res.json({ ok: true });
  }));

  // Redo everything from the saved recording: transcript, speaker names, notes. Edits (renamed speakers, notes) are replaced.
  r.post('/meetings/:id/reprocess', wrap(async (req, res) => {
    const m = await col('meetings').findOne({ _id: req.params.id, uid: req.user.uid });
    if (!m) return res.status(404).json({ error: 'Not found' });
    if (m.status === 'recording' || m.status === 'processing') return res.status(409).json({ error: 'This recording is still being processed.' });
    const up = m.uploadId && await col('uploads').findOne({ _id: m.uploadId });
    if (up?.status !== 'uploaded' || !fs.existsSync(mediaPath(m._id))) return res.status(409).json({ error: 'The recording file is not available, so it cannot be processed again.' });
    await col('meetings').updateOne({ _id: m._id }, {
      $set: { status: 'processing', reprocessedAt: new Date() },
      $unset: { segments: '', summary: '', speakers: '', durationSec: '', readyAt: '', error: '', lastError: '', uploadState: '' },
    });
    // Runs in the background; the page polls while the status is "processing".
    ingest(await col('meetings').findOne({ _id: m._id })).catch((e) => console.error('reprocess:', e.message));
    res.status(202).json({ ok: true });
  }));

  r.post('/meetings/:id/summarize', wrap(async (req, res) => {
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is not set up on the server' });
    const m = await col('meetings').findOne({ _id: req.params.id, uid: req.user.uid });
    if (!m?.segments?.length) return res.status(400).json({ error: 'No transcript yet' });
    if (req.body?.template && !TEMPLATES.some((t) => t.id === req.body.template)) return res.status(400).json({ error: 'Unknown summary template.' });
    await runSummary(m._id, req.body?.template);
    res.json((await col('meetings').findOne({ _id: m._id })).summary);
  }));

  r.get('/meetings/:id/export', wrap(async (req, res) => {
    const m = await col('meetings').findOne({ _id: req.params.id, uid: req.user.uid });
    if (!m) return res.status(404).json({ error: 'Not found' });
    const f = String(req.query.format || 'txt');
    const body = f === 'vtt' ? toVtt(m.segments || []) : f === 'srt' ? toSrt(m.segments || []) : toText(m.segments || []);
    res.type('text/plain; charset=utf-8').send(body);
  }));

  // ---------- Ask AI (streamed) ----------
  r.post('/chat', wrap(async (req, res) => {
    if (!aiConfigured()) return res.status(503).json({ error: 'AI is not set up on the server' });
    const messages = (req.body.messages || []).filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content).slice(-12);
    if (messages.at(-1)?.role !== 'user') return res.status(400).json({ error: 'Last message must be from the user' });
    const single = !!req.body.meetingId;
    const filter = single ? { _id: req.body.meetingId, uid: req.user.uid } : { uid: req.user.uid, status: 'ready' };
    const meetings = await col('meetings').find(filter).sort({ startedAt: -1 }).limit(single ? 1 : 60).toArray();
    if (!meetings.length) return res.status(404).json({ error: single ? 'Meeting not found' : 'No meetings yet' });
    const context = buildContext(meetings, messages.at(-1).content, single);

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      await streamChat({ context, messages, onText: (t) => send({ t }) });
    } catch (e) { send({ error: e.message }); }
    res.write('data: [DONE]\n\n');
    res.end();
  }));

  // ---------- calendar ----------
  r.get('/calendar/status', wrap(async (req, res) => {
    const a = await col('calendar_accounts').findOne({ uid: req.user.uid }, { projection: { email: 1, provider: 1, syncedAt: 1 } });
    res.json({ configured: calendarConfigured(), account: a });
  }));
  r.get('/calendar/google/start', (req, res) => {
    if (!calendarConfigured()) return res.status(503).json({ error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET' });
    res.json({ url: authUrl(req.user) });
  });
  r.post('/calendar/sync', wrap(async (req, res) => res.json({ count: await syncCalendar(req.user) })));
  r.delete('/calendar/account', wrap(async (req, res) => {
    await col('calendar_accounts').deleteOne({ uid: req.user.uid });
    await col('calendar_events').deleteMany({ uid: req.user.uid });
    res.json({ ok: true });
  }));
  r.get('/calendar/events', wrap(async (req, res) => {
    const from = new Date(String(req.query.from || Date.now() - 864e5)), to = new Date(String(req.query.to || Date.now() + 14 * 864e5));
    const events = await col('calendar_events').find({ uid: req.user.uid, start: { $gte: from, $lt: to } }).sort({ start: 1 }).toArray();
    const ids = events.map((e) => e.eventId);
    const recs = await col('meetings').find({ uid: req.user.uid, calendarEventId: { $in: ids } }, { projection: { calendarEventId: 1, status: 1, startedAt: 1 } }).toArray();
    res.json({ events: events.map((e) => ({ ...e, meeting: recs.find((m) => m.calendarEventId === e.eventId) || null })) });
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return r;
}
