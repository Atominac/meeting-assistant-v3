// Finds which Meet page classes switch on and off with speech, per tile.
//   node tools/speaking-probe.mjs [seconds]      (default 60; Ctrl+C prints what it has so far)
// While it runs, have each person in the call take turns speaking (one at a time, a few seconds each).
// It prints, for each tile, the classes that were present only some of the time.
import { createRequire } from 'node:module';
const sdk = createRequire(import.meta.url)('../packages/sdk');
const seconds = Number(process.argv[2]) || 60;
await sdk.init({ apiUrl: 'https://api.example.com', disableDetection: true });
const seen = {};      // name -> { class -> samples present }
const samples = {};   // name -> total samples
const speakingNow = {};
let stop = false;

function report() {
  console.log('\n\nCurrent rule marked as speaking (samples):', JSON.stringify(speakingNow));
  for (const [name, n] of Object.entries(samples)) {
    const toggling = Object.entries(seen[name]).filter(([, k]) => k < n).sort((a, b) => a[1] - b[1]);
    console.log(`\n${name}: ${n} samples. Classes present only part of the time:`);
    for (const [cls, k] of toggling) console.log(`  ${cls.padEnd(14)} ${k}/${n}`);
    if (!toggling.length) console.log('  (none: nothing on this tile changed)');
  }
}
process.on('SIGINT', () => { stop = true; });

console.log(`Sampling for ${seconds}s (a sample takes about 2s). Take turns speaking now…`);
const end = Date.now() + seconds * 1000;
try {
  while (!stop && Date.now() < end) {
    for (const m of await sdk._debug('debugScrape', { classes: true })) {
      for (const tile of m.tiles || []) {
        samples[tile.name] = (samples[tile.name] || 0) + 1;
        const c = (seen[tile.name] ||= {});
        for (const cls of tile.classes) c[cls] = (c[cls] || 0) + 1;
      }
      for (const p of m.participants) if (p.speaking) speakingNow[p.name] = (speakingNow[p.name] || 0) + 1;
    }
    process.stdout.write(`\r${Math.max(0, Math.ceil((end - Date.now()) / 1000))}s left  `);
  }
  report();
} finally { await sdk.shutdown(); }
