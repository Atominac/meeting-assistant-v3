import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { env } from './env.js';
import { connect } from './db.js';
import { createApi } from './api.js';
import { startWorker } from './ingest.js';
import { startCalendarSync, calendarConfigured } from './calendar.js';
import { recordingConfigured } from './recording.js';
import { aiConfigured } from './ai.js';

// V3 must never share a database with V2: each one's background worker would mishandle the other's meetings.
if (env.mongoDb === 'meeting_assistant_v2') {
  console.error('\nMONGODB_DB is meeting_assistant_v2, which is Meeting Assistant v2\'s database. Use meeting_assistant_v3 for v3.\n');
  process.exit(1);
}
try { await connect(); } catch (e) {
  // Atlas drops the TLS handshake ("alert internal error") for an IP that is not on its Network Access list.
  const blocked = /tlsv1 alert internal error|alert number 80|ReplicaSetNoPrimary|Server selection timed out/i.test(e.message);
  console.error(`\nCould not connect to MongoDB: ${e.message}\nCheck MONGODB_URI in .env.${blocked ? '\nThis usually means Atlas is blocking this computer: in Atlas > Security > Network Access, add your current IP (or check the cluster is not paused).' : ''}\n`);
  process.exit(1);
}
fs.mkdirSync(path.join(env.dataDir, 'media'), { recursive: true });

const app = express();
app.disable('x-powered-by');
// GoHighLevel embeds this app in an iframe, so allow only its domains to frame us (no X-Frame-Options).
app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${env.frameAncestors}`); next(); });
app.use('/api', createApi());

const dist = path.resolve(import.meta.dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('Web app not built. Run: npm run build'));
}
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });

startWorker();
startCalendarSync();
app.listen(env.port, () => {
  console.log(`Meeting Assistant on ${env.publicUrl}   (sign-up: ${env.signupCode ? 'invite code required' : 'open'})`);
  console.log(`  Recording:        ${recordingConfigured() ? 'on' : 'OFF'}`);
  console.log(`  AI (OpenAI):      ${aiConfigured() ? 'on' : 'OFF (OPENAI_API_KEY)'}`);
  console.log(`  Google Calendar:  ${calendarConfigured() ? 'on' : 'OFF (GOOGLE_CLIENT_ID/SECRET)'}`);
});
