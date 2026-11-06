// Shows the participants the SDK can read from the meetings open right now (Meet, Zoom, Teams).
//   node tools/participants.mjs            once
//   node tools/participants.mjs --watch    every 1.5 s for 60 s, printing only changes (unmute and speak to test)
import { createRequire } from 'node:module';
const sdk = createRequire(import.meta.url)('../packages/sdk');
const watch = process.argv.includes('--watch');
await sdk.init({ apiUrl: 'https://api.example.com', disableDetection: true });

const render = (meetings) => meetings.map((m) =>
  `${m.key}${m.live ? '' : ' (not live)'}\n` + (m.participants.length
    ? m.participants.map((p) => `  ${p.name}${p.isHost ? ' [host]' : ''}${p.speaking ? ' [SPEAKING]' : ''}`).join('\n')
    : '  (no participants found)')).join('\n') || 'No meeting found on screen.';

try {
  let last = '';
  for (let i = 0; i < (watch ? 40 : 1); i++) {
    const text = render(await sdk._debug('debugScrape', {}));
    if (text !== last) { console.log((watch ? `--- ${new Date().toLocaleTimeString()}\n` : '') + text); last = text; }
    if (watch) await new Promise((r) => setTimeout(r, 1500));
  }
} finally { await sdk.shutdown(); }
