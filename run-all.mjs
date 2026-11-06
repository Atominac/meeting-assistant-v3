// One command for everything on a dev machine: npm start
// Builds what is missing (SDK helper, web app), starts the server, waits until it is up, then opens the desktop app.
// Ctrl+C stops both. Flags: --no-desktop (server only).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const desktopDir = path.join(root, 'desktop');
const sdkRoot = path.resolve(root, '..', 'meeting-sdk');
const withDesktop = !process.argv.includes('--no-desktop');
const fail = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

if (!fs.existsSync(path.join(root, '.env'))) fail('No .env file. Run: cp .env.example .env  and fill in MONGODB_URI, DEEPGRAM_API_KEY and OPENAI_API_KEY.');
const port = Number((fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^PORT=(\d+)/m) || [])[1]) || 3002;

if (!fs.existsSync(path.join(root, 'node_modules'))) { console.log('Installing server and web dependencies…'); run('npm', ['install']); }
if (withDesktop && !fs.existsSync(path.join(desktopDir, 'node_modules'))) { console.log('Installing desktop dependencies…'); run('npm', ['install'], { cwd: desktopDir }); }

if (withDesktop && process.platform === 'darwin') {
  const helper = path.join(sdkRoot, 'packages', 'sdk', 'bin', 'meeting-sdk-macos');
  if (!fs.existsSync(helper)) {
    console.log('Building the recording helper (first run only)…');
    if (run(path.join(sdkRoot, 'native', 'macos', 'build.sh')).status !== 0) fail('Could not build the recording helper. See ../meeting-sdk/README.md.');
  }
}

console.log('Building the web app…');
if (run('npm', ['run', 'build']).status !== 0) fail('The web app did not build.');

const server = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], { cwd: root, stdio: 'inherit' });
let stopping = false;
server.on('exit', (code) => { if (!stopping) { console.error(`\nThe server stopped (exit ${code}), so the desktop app was not started or has been closed.`); stop(code || 1); } });

function stop(code = 0) {
  stopping = true;
  server.kill();
  // The desktop app is started with `open`, so find it by its folder.
  if (withDesktop) spawnSync('pkill', ['-f', `Electron.*${desktopDir}`]);
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const up = async () => {
  for (let i = 0; i < 60 && !stopping; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

if (!(await up())) { if (!stopping) fail('The server did not come up in 30 seconds. See the messages above.'); }
else if (withDesktop) {
  console.log('\nServer is up. Opening the desktop app… (Ctrl+C here stops everything)\n');
  if (process.platform === 'darwin') {
    // Started through `open` so macOS attributes Accessibility / Screen Recording to the app, not to this terminal.
    spawnSync('open', ['-n', path.join(desktopDir, 'node_modules', 'electron', 'dist', 'Electron.app'), '--args', desktopDir]);
  } else {
    spawn('npm', ['run', 'start'], { cwd: desktopDir, stdio: 'inherit', shell: true });
  }
}
