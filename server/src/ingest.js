import fs from 'node:fs';
import { col } from './db.js';
import { mediaPath } from './recording.js';
import { speechIntervals, assignSpeakers, buildSpeakers } from './transcript.js';
import { transcribeRecording, transcriptionConfigured } from './transcribe.js';
import { summarize, aiConfigured } from './ai.js';
import { env } from './env.js';

export { mediaPath };
const inflight = new Set();
const GIVE_UP_MS = 3 * 3600_000;

// Turns an uploaded recording into a transcript with speaker names, then writes the notes.
export async function ingest(meeting) {
  if (inflight.has(meeting._id)) return;
  inflight.add(meeting._id);
  const set = (patch) => col('meetings').updateOne({ _id: meeting._id }, { $set: patch });
  try {
    const up = await col('uploads').findOne({ _id: meeting.uploadId });
    if (!up) return await set({ status: 'failed', error: 'The upload record is missing' });
    if (up.status === 'failed') return await set({ status: 'failed', error: up.error || 'The upload failed' });
    // The desktop app may have crashed before reporting "ended"; the finished upload is the source of truth.
    if (meeting.status === 'recording' && up.status === 'uploaded') await set({ status: 'processing', endedAt: new Date() });
    else if (meeting.status === 'recording') return;
    if (up.status !== 'uploaded') return await set({ uploadState: up.status });

    const file = mediaPath(meeting._id);
    let segments = [];
    if (transcriptionConfigured()) {
      const events = await col('upload_events').find({ uploadId: up._id }).toArray();
      const raw = await transcribeRecording(file);
      const end = raw.at(-1)?.end ?? 0;
      const known = await col('meetings').findOne({ _id: meeting._id }, { projection: { participants: 1, userName: 1 } });
      const people = [...new Set((known?.participants || []).map((p) => p.name).filter(Boolean))];
      segments = assignSpeakers(raw, speechIntervals(events, end), { people, me: known?.userName || null });
    }
    const durationSec = Math.round(segments.at(-1)?.end || (up.uploadedAt && meeting.startedAt ? (up.uploadedAt - meeting.startedAt) / 1000 : 0));
    const fresh = await col('meetings').findOne({ _id: meeting._id }, { projection: { participants: 1 } });
    await set({
      status: 'ready', uploadState: 'complete', segments,
      speakers: buildSpeakers(fresh?.participants, segments), hasVideo: fs.existsSync(file), durationSec, readyAt: new Date(),
    });
    if (aiConfigured() && segments.length) await runSummary(meeting._id).catch((e) => console.error('summary:', e.message));
  } catch (e) {
    console.error(`ingest ${meeting._id}:`, e.message);
    if (Date.now() - new Date(meeting.reprocessedAt || meeting.endedAt || meeting.startedAt) > GIVE_UP_MS) await set({ status: 'failed', error: e.message });
    else await set({ lastError: e.message });
  } finally {
    inflight.delete(meeting._id);
  }
}

// Template: the one asked for, else the user's default, else general.
export async function runSummary(id, template) {
  const m = await col('meetings').findOne({ _id: id });
  const user = template ? null : await col('users').findOne({ _id: m.uid }, { projection: { prefs: 1 } });
  const summary = await summarize(m, template || user?.prefs?.summaryTemplate);
  const patch = { summary };
  if (!m.titleLocked && summary.title && !m.calendarEventId) patch.title = summary.title;
  await col('meetings').updateOne({ _id: id }, { $set: patch });
}

export function startWorker() {
  if (!transcriptionConfigured()) console.warn('DEEPGRAM_API_KEY (or OPENAI_API_KEY) missing: recordings are saved but not transcribed');
  const tick = async () => {
    const stale = new Date(Date.now() - 3 * 60_000);
    const list = await col('meetings').find({ $or: [{ status: 'processing' }, { status: 'recording', startedAt: { $lt: stale } }] }).limit(20).toArray();
    await Promise.all(list.map(ingest));
  };
  setInterval(() => tick().catch((e) => console.error('worker:', e.message)), 15_000).unref();
  tick().catch(() => {});
}
