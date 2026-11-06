// Prints what the recording pipeline knew about a meeting, to see why speaker names came out as they did.
//   npm -w server run debug-meeting            (the latest meeting)
//   npm -w server run debug-meeting -- <meetingId>
import { connect, close, col } from '../src/db.js';

await connect();
const m = process.argv[2]
  ? await col('meetings').findOne({ _id: process.argv[2] })
  : (await col('meetings').find().sort({ startedAt: -1 }).limit(1).toArray())[0];
if (!m) { console.log('No meeting found.'); process.exit(1); }

const up = m.uploadId && await col('uploads').findOne({ _id: m.uploadId });
const events = up ? await col('upload_events').find({ uploadId: up._id }).sort({ relative: 1 }).toArray() : [];
console.log(`Meeting ${m._id}  "${m.title}"  status=${m.status}  ${m.platform}`);
console.log(`Upload: ${up?.status || 'none'}, ${up?.bytes || 0} bytes, ${up?.events || 0} participant events`);
console.log('\nParticipants the app reported:', (m.participants || []).map((p) => p.name).join(', ') || '(none)');
console.log('\nParticipant events from the SDK (seconds into the recording):');
for (const e of events) console.log(`  ${e.relative.toFixed(1).padStart(7)}s  ${e.event.replace('participant_events.', '').padEnd(10)} ${e.name}`);
if (!events.length) console.log('  (none: the SDK saw nobody join, leave or speak)');
console.log('\nTranscript segments:');
for (const s of m.segments || []) console.log(`  ${s.start.toFixed(1).padStart(7)}s  ${s.speaker}: ${s.text.slice(0, 80)}`);
await close();
