import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import OpenAI from 'openai';
import { env } from './env.js';

// OpenAI's transcription endpoint takes files up to 25 MB.
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
let client;
const openai = () => (client ||= new OpenAI({ apiKey: env.openaiKey }));

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').pop()}`))));
});

export async function hasFfmpeg() {
  try { await run(env.ffmpeg, ['-version']); return true; } catch { return false; }
}

// The recording has the meeting audio and the microphone as two audio tracks. ffmpeg mixes them into one small
// mono file. Without ffmpeg the MP4 is sent as it is, which only works for short calls and uses the first track.
// `stereo` keeps the two tracks apart (left: other people, right: the local microphone) so the transcriber can tell
// the local user from everyone else by channel, which no screen reading is needed for.
async function prepareAudio(file, { stereo = false } = {}) {
  if (await hasFfmpeg()) {
    const out = path.join(os.tmpdir(), `ma-${path.basename(file, '.mp4')}.mp3`);
    const tail = ['-vn', '-ar', '16000', '-b:a', stereo ? '48k' : '32k', '-y', out];
    if (stereo) {
      try {
        await run(env.ffmpeg, ['-i', file, '-filter_complex', '[0:a:0]aformat=channel_layouts=mono[l];[0:a:1]aformat=channel_layouts=mono[r];[l][r]amerge=inputs=2[a]', '-map', '[a]', ...tail]);
        return { file: out, temp: true, stereo: true };
      } catch { /* only one audio track: fall through to mono */ }
    }
    const mono = ['-ac', '1', ...tail];
    try {
      await run(env.ffmpeg, ['-i', file, '-filter_complex', '[0:a:0][0:a:1]amix=inputs=2:duration=longest:normalize=0[a]', '-map', '[a]', ...mono]);
    } catch {
      await run(env.ffmpeg, ['-i', file, '-map', '0:a:0', ...mono]);   // only one audio track
    }
    return { file: out, temp: true, stereo: false };
  }
  if (fs.statSync(file).size > MAX_UPLOAD_BYTES) {
    throw new Error('Install ffmpeg on the server (brew install ffmpeg) to transcribe recordings this long.');
  }
  return { file, temp: false };
}

export const transcriptionConfigured = () => !!(env.deepgramKey || env.openaiKey);
export const transcriptionProvider = () => (env.deepgramKey ? 'deepgram' : env.openaiKey ? 'openai' : null);

/** Returns [{ start, end, text, fallback }] in seconds from the start of the recording. */
export async function transcribeRecording(file) {
  return env.deepgramKey ? transcribeWithDeepgram(file) : transcribeWithOpenAI(file);
}

// Deepgram takes the file as the request body (up to 2 GB), so long calls work even without ffmpeg. With ffmpeg the two
// audio tracks (meeting + microphone) are mixed first; without it Deepgram reads the first track of the MP4.
async function transcribeWithDeepgram(file) {
  const useFfmpeg = await hasFfmpeg();
  const audio = useFfmpeg ? await prepareAudio(file, { stereo: true }) : { file, temp: false, stereo: false };
  try {
    const params = new URLSearchParams({
      model: env.deepgramModel, language: env.deepgramLanguage, smart_format: 'true', punctuate: 'true',
      utterances: 'true', utt_split: '0.8', diarize: 'true',
    });
    if (audio.stereo) params.set('multichannel', 'true');
    const size = fs.statSync(audio.file).size;
    const res = await fetch(`${env.deepgramUrl}/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${env.deepgramKey}`, 'Content-Type': useFfmpeg ? 'audio/mpeg' : 'video/mp4', 'Content-Length': String(size) },
      body: Readable.toWeb(fs.createReadStream(audio.file)),
      duplex: 'half',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Deepgram ${res.status}: ${text.slice(0, 300)}`);
    return parseDeepgram(JSON.parse(text));
  } finally {
    if (audio.temp) fs.rm(audio.file, { force: true }, () => {});
  }
}

/** Deepgram's utterances -> segments. `fallback` is the diarized speaker label, used when no name is known. */
export function parseDeepgram(body) {
  const utterances = body?.results?.utterances;
  if (Array.isArray(utterances) && utterances.length) {
    return utterances
      .map((u) => ({ start: u.start, end: u.end, text: String(u.transcript || '').trim(), ...(Number.isInteger(u.channel) ? { channel: u.channel } : {}), fallback: Number.isInteger(u.speaker) ? `Speaker ${u.speaker + 1}` : 'Speaker' }))
      .filter((s) => s.text);
  }
  // No utterances (e.g. a very short clip): fall back to the whole transcript as one segment.
  const alt = body?.results?.channels?.[0]?.alternatives?.[0];
  const words = alt?.words || [];
  return alt?.transcript ? [{ start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? 0, text: alt.transcript.trim(), fallback: 'Speaker' }] : [];
}

async function transcribeWithOpenAI(file) {
  const audio = await prepareAudio(file);
  try {
    if (fs.statSync(audio.file).size > MAX_UPLOAD_BYTES) throw new Error('Recording is too long to transcribe in one piece.');
    const res = await openai().audio.transcriptions.create({
      file: fs.createReadStream(audio.file), model: env.transcribeModel, response_format: 'verbose_json',
    });
    return (res.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })).filter((s) => s.text);
  } finally {
    if (audio.temp) fs.rm(audio.file, { force: true }, () => {});
  }
}
