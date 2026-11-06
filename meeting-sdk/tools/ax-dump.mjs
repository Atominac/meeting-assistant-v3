// Dump the accessibility tree of a running app, to build detection rules from real meetings.
//   node tools/ax-dump.mjs apps                      list running apps
//   node tools/ax-dump.mjs tree "Google Chrome"      dump one app (name, bundle id or executable name)
// The terminal running this needs the Accessibility permission (System Settings > Privacy & Security).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const sdk = createRequire(import.meta.url)('../packages/sdk');
const [mode, name, outDir] = process.argv.slice(2);

await sdk.init({ apiUrl: 'https://api.example.com' });
try {
  if (mode === 'apps') {
    for (const a of await sdk.dumpAllApplications()) console.log(String(a.pid).padStart(6), a.bundleId ?? '-', '|', a.name ?? '');
  } else if (mode === 'tree' && name) {
    for (const { pid, tree } of await sdk.dumpAXTree(name)) {
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, `${name.replace(/\W+/g, '_')}-${pid}-${Date.now()}.txt`);
        fs.writeFileSync(file, tree);
        console.log('wrote', file);
      } else {
        console.log(`# pid ${pid}\n${tree}`);
      }
    }
  } else {
    console.error('usage: ax-dump.mjs apps | tree <app> [outDir]');
    process.exitCode = 2;
  }
} finally {
  await sdk.shutdown();
}
