import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { col } from './db.js';
import { env } from './env.js';

// The desktop SDK uploads to `<apiUrl>/upload/<token>/media` and `/events`. This server hands out the token
// and keeps what comes back, so no outside recording service is involved.
export const recordingConfigured = () => true;
export const mediaPath = (meetingId) => path.join(env.dataDir, 'media', `${meetingId}.mp4`);
const MAX_MEDIA_BYTES = 4 * 1024 ** 3;
const MAX_EVENTS = 50_000;

export async function createUpload({ meetingId, uid, userName }) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('base64url');
  await col('uploads').insertOne({ _id: id, token, meetingId, uid, userName: userName || null, status: 'created', bytes: 0, events: 0, createdAt: new Date() });
  return { id, upload_token: token };
}

// Meet labels the local user's own tile "You"; the signed-in user's name is used instead.
export const realName = (name, me) => {
  const n = String(name || '').trim().slice(0, 120);
  return /^you$/i.test(n) && me ? me : n;
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Registered before express.json(): the media body is a raw stream.
export function attachUploadRoutes(r) {
  r.put('/sdk/upload/:token/media', wrap(async (req, res) => {
    const up = await col('uploads').findOne({ token: req.params.token });
    if (!up) return res.status(401).json({ error: 'unknown upload token' });
    if (up.status === 'uploaded') return res.status(409).json({ error: 'already uploaded' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_MEDIA_BYTES) return res.status(413).json({ error: 'recording too large' });

    const file = mediaPath(up.meetingId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await col('uploads').updateOne({ _id: up._id }, { $set: { status: 'receiving' } });
    try {
      await pipeline(req, fs.createWriteStream(file));
    } catch (e) {
      await col('uploads').updateOne({ _id: up._id }, { $set: { status: 'failed', error: e.message } });
      throw e;
    }
    const bytes = fs.statSync(file).size;
    await col('uploads').updateOne({ _id: up._id }, { $set: { status: 'uploaded', bytes, uploadedAt: new Date() } });
    res.json({ received: bytes });
  }));

  // Participant events (joins, leaves, who is speaking) with the SDK's timestamps.
  r.post('/sdk/upload/:token/events', express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const up = await col('uploads').findOne({ token: req.params.token });
    if (!up) return res.status(401).json({ error: 'unknown upload token' });
    if (up.events >= MAX_EVENTS) return res.json({ ok: true, dropped: true });
    const { event, data } = req.body || {};
    if (typeof event !== 'string' || !event.startsWith('participant_events.')) return res.status(400).json({ error: 'unsupported event' });
    await col('upload_events').insertOne({
      uploadId: up._id, event, name: realName(data?.participant?.name, up.userName),
      participantId: data?.participant?.id ?? null, relative: Number(data?.timestamp?.relative) || 0,
      absolute: data?.timestamp?.absolute || null,
    });
    await col('uploads').updateOne({ _id: up._id }, { $inc: { events: 1 } });
    res.json({ ok: true });
  }));
}
