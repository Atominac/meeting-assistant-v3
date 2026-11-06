// Stand-in for the server side. Issues upload tokens and accepts recording chunks and realtime events.
// Run: node mock-server/server.mjs   (PORT defaults to 4010)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 4010);
const DATA = path.resolve(import.meta.dirname, '..', 'data', 'uploads');
fs.mkdirSync(DATA, { recursive: true });

const uploads = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // The app's backend calls this to get a short-lived token for startRecording.
  if (req.method === 'POST' && url.pathname === '/api/v1/sdk-upload') {
    const id = randomUUID();
    const token = randomUUID();
    uploads.set(token, { id, createdAt: new Date().toISOString(), bytes: 0, events: 0 });
    fs.mkdirSync(path.join(DATA, id), { recursive: true });
    return json(res, 201, { id, upload_token: token });
  }

  // Recording media arrives here, authorised by the upload token.
  const media = url.pathname.match(/^\/upload\/([^/]+)\/media$/);
  if (media && (req.method === 'PUT' || req.method === 'POST')) {
    const entry = uploads.get(media[1]);
    if (!entry) return json(res, 401, { error: 'unknown upload token' });
    const out = fs.createWriteStream(path.join(DATA, entry.id, 'recording.part'), { flags: 'a' });
    req.on('data', (chunk) => { entry.bytes += chunk.length; });
    req.pipe(out);
    out.on('finish', () => json(res, 200, { received: entry.bytes }));
    return;
  }

  // Realtime events (participant joins, speaker changes, ...).
  const events = url.pathname.match(/^\/upload\/([^/]+)\/events$/);
  if (events && req.method === 'POST') {
    const entry = uploads.get(events[1]);
    if (!entry) return json(res, 401, { error: 'unknown upload token' });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      entry.events++;
      fs.appendFileSync(path.join(DATA, entry.id, 'events.jsonl'), body.trim() + '\n');
      json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, uploads: uploads.size });
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`mock server on http://localhost:${PORT}  (data: ${DATA})`));
