// Checks the Deepgram key end to end: macOS reads a sentence aloud into a file, then the server's own
// transcription code sends it to Deepgram. Run: npm -w server run test-deepgram
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { env } from '../src/env.js';
import { transcribeRecording, transcriptionProvider } from '../src/transcribe.js';

if (transcriptionProvider() !== 'deepgram') {
  console.error('DEEPGRAM_API_KEY is not set in .env');
  process.exit(1);
}
const file = path.join(os.tmpdir(), 'deepgram-check.m4a');
execFileSync('say', ['-o', file, '--data-format=aac', 'Welcome everyone. This is a short test of the meeting transcription.']);
const segments = await transcribeRecording(file);
console.log(`model ${env.deepgramModel}:`, segments.length ? segments.map((s) => `[${s.start.toFixed(1)}s] ${s.fallback}: ${s.text}`).join('\n') : '(no speech found)');
