import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '..', '.env') });

export const env = {
  port: Number(process.env.PORT) || 3002,
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${Number(process.env.PORT) || 3002}`).replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data')),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'meeting_assistant_v3',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  deepgramKey: process.env.DEEPGRAM_API_KEY,
  deepgramUrl: (process.env.DEEPGRAM_API_URL || 'https://api.deepgram.com').replace(/\/$/, ''),
  deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
  deepgramLanguage: process.env.DEEPGRAM_LANGUAGE || 'en',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'whisper-1',
  openaiKey: process.env.OPENAI_API_KEY,
  aiModel: process.env.OPENAI_MODEL || 'gpt-4.1',
  signupCode: process.env.SIGNUP_CODE, // when set, new accounts must enter it
  sessionSecret: process.env.SESSION_SECRET,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  frameAncestors: process.env.FRAME_ANCESTORS || 'https://*.gohighlevel.com https://*.leadconnectorhq.com https://*.msgsndr.com',
};
