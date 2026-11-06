// Try the SDK on a real call. Prints every event. With --record it records each meeting it detects.
//   node mock-server/server.mjs                 (in another terminal)
//   node tools/live.mjs [--record]
// Ctrl+C stops the recording (if any) and exits.
import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('../packages/sdk');
const API = process.env.API_URL || 'http://localhost:4010';
const record = process.argv.includes('--record');
const active = new Set();

const EVENTS = ['meeting-detected', 'meeting-updated', 'meeting-closed', 'recording-started', 'recording-ended',
  'media-capture-status', 'realtime-event', 'error', 'permission-status', 'shutdown'];
for (const type of EVENTS) {
  sdk.addEventListener(type, (e) => {
    const stamp = new Date().toISOString().slice(11, 23);
    if (type === 'permission-status' && e.status === 'granted') return;
    console.log(stamp, type.padEnd(22), JSON.stringify(e));
  });
}

sdk.addEventListener('meeting-detected', async ({ window: w }) => {
  if (!record) return;
  const { upload_token } = await (await fetch(`${API}/api/v1/sdk-upload`, { method: 'POST' })).json();
  await sdk.startRecording({ windowId: w.id, uploadToken: upload_token });
  active.add(w.id);
});
sdk.addEventListener('meeting-closed', async ({ window: w }) => {
  if (active.delete(w.id)) await sdk.stopRecording({ windowId: w.id });
});

await sdk.init({ apiUrl: API, dev: true, acquirePermissionsOnStartup: ['accessibility', 'screen-capture', 'microphone'] });
console.log(`SDK running. Join a Meet / Zoom / Teams call. ${record ? 'Recording is ON.' : 'Pass --record to record.'}`);

process.on('SIGINT', async () => {
  for (const id of active) await sdk.stopRecording({ windowId: id }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));   // let the file finish and upload
  await sdk.shutdown().catch(() => {});
  process.exit(0);
});
