// Cross-platform launcher for `npm start` / `npm run demo` (the old scripts used the Unix-only `env -u`).
// Electron must not start in "run as plain Node" mode, so that variable is removed before launching.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--demo')) env.MA_DEMO = '1';

const child = spawn(electron, ['.'], { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
