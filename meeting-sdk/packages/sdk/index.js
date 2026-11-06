'use strict';
// Node wrapper around the native helper process.
//
// Wire protocol (one JSON object per line):
//   wrapper -> helper (stdin):  {"command", "commandId", "writeSequence", "params"}
//   helper -> wrapper (stdout): "msdk|" + {"type":"response","commandId","status":"success"|"error","result"}
//                               "msdk|" + {"type":"event","event":"<JSON string of {type,payload}>"}
// Lines without the prefix are ordinary helper output and are ignored.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PREFIX = 'msdk|';
const ENV_PREFIX = 'MSDK_';
const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
const SHUTDOWN_KILL_MS = 5000;
const MAX_AUTOMATIC_RESTARTS = 10;

// Electron's asar archive reports packed files as present, so look in the unpacked copy first.
const exePaths = [];
if (process.platform === 'darwin') {
  const exe = path.join(__dirname, 'bin', 'meeting-sdk-macos');
  exePaths.push(exe.replace('app.asar', 'app.asar.unpacked'), exe);
} else if (process.platform === 'win32') {
  const exe = path.join(__dirname, 'bin', 'meeting-sdk-windows.exe');
  exePaths.push(exe.replace('app.asar', 'app.asar.unpacked'), exe);
}

let proc = null;
let lastOptions;
let exiting = false;
let remainingRestarts = MAX_AUTOMATIC_RESTARTS;
let nextWriteSequence = 1;
const listeners = [];
const pending = new Map();

process.on('exit', () => {
  exiting = true;
  if (proc && !proc.killed) proc.kill();
});

function emitEvent(type, payload) {
  for (const l of [...listeners]) if (l.type === type) l.callback(payload);
}

function flushPending(err) {
  for (const [id, p] of pending) { p.reject(err); pending.delete(id); }
}

function sendCommand(command, params = {}) {
  return new Promise((resolve, reject) => {
    const p = proc;
    if (!p || p.exitCode !== null || p.killed || !p.stdin || p.stdin.destroyed || !p.stdin.writable) {
      reject(new Error('The SDK is not started or is no longer accepting commands; call `shutdown` and `init` to start it again.'));
      return;
    }
    const commandId = randomUUID();
    const writeSequence = nextWriteSequence++;
    pending.set(commandId, { resolve, reject, command });
    p.stdin.write(JSON.stringify({ command, commandId, writeSequence, params }) + '\n', (err) => {
      if (!err) return;
      const entry = pending.get(commandId);
      if (!entry) return;
      pending.delete(commandId);
      entry.reject(new Error(`Failed writing ${command} command [${writeSequence}] to the SDK helper: ${err.message}`));
    });
  });
}

function handleLine(line) {
  if (!line || !line.startsWith(PREFIX)) return;
  let data;
  try { data = JSON.parse(line.slice(PREFIX.length)); } catch { return; }
  if (data.type === 'event' && data.event) {
    try {
      const ev = JSON.parse(data.event);
      emitEvent(ev.type, ev.payload);
    } catch { /* malformed event: drop */ }
  } else if (data.type === 'response') {
    const entry = pending.get(data.commandId);
    if (!entry) return;
    pending.delete(data.commandId);
    if (data.status === 'success') entry.resolve(data.result ?? null);
    else entry.reject(new Error(typeof data.result === 'string' ? data.result : JSON.stringify(data.result)));
  }
}

function startProcess() {
  if (proc && proc.exitCode === null) throw new Error('The SDK helper is already started');
  const override = process.env.MSDK_HELPER_PATH;
  const exe = override || exePaths.find((p) => fs.existsSync(p));
  if (!exe) throw new Error(`Couldn't launch the SDK helper. Tried: ${exePaths.join(', ')}`);

  const env = { ...process.env };
  for (const name of PROXY_ENV) {
    for (const spelling of process.platform === 'win32' ? [name] : [name, name.toLowerCase()]) {
      if (process.env[spelling] !== undefined) env[spelling] = process.env[spelling];
    }
  }
  env.EXE_NAME = path.parse(process.execPath).name;
  const version = readVersion();
  if (version) env.SDK_VERSION = version;
  if (lastOptions && lastOptions.testMode) env.TEST_MODE = '1';
  if (lastOptions && lastOptions.testTargetBundleId) env.TEST_TARGET_BUNDLE_ID = lastOptions.testTargetBundleId;
  if (lastOptions && lastOptions.testSpeedModifier) env.TEST_SPEED_MODIFIER = String(lastOptions.testSpeedModifier);
  env.MSDK_TMPDIR = os.tmpdir();

  const current = spawn(exe, { stdio: ['pipe', 'pipe', 'pipe'], env });
  proc = current;

  current.stdin.on('error', () => {
    if (proc !== current || exiting) return;
    flushPending(new Error('SDK helper stdin error'));
    if (current.exitCode === null && !current.killed) current.kill();
  });
  readline.createInterface({ input: current.stdout, crlfDelay: Infinity }).on('line', handleLine);
  readline.createInterface({ input: current.stderr, crlfDelay: Infinity }).on('line', (line) => {
    if (process.env.MSDK_DEBUG) console.error(line);
  });

  current.on('error', (error) => {
    if (proc !== current) return;
    proc = null;
    flushPending(new Error(`Process error: ${error.message}`));
    emitEvent('error', { type: 'process', message: 'The SDK helper process has failed to start or exited improperly.' });
  });

  current.on('close', (code, signal) => {
    if (proc !== current) return;
    proc = null;
    flushPending(new Error(`Process exited with code ${code}, signal ${signal}.`));
    emitEvent('shutdown', { code: code ?? 0, signal: signal ?? '' });
    if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM' || exiting) return;
    emitEvent('error', { type: 'process', message: 'The SDK helper process exited unexpectedly.' });
    if (lastOptions && lastOptions.restartOnError && remainingRestarts > 0) {
      remainingRestarts--;
      doInit(lastOptions).catch(() => { /* surfaced through the error event */ });
    }
  });
}

let cachedVersion;
function readVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try { cachedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
  catch { cachedVersion = null; }
  return cachedVersion;
}

async function doInit(options) {
  startProcess();
  await sendCommand('init', { config: JSON.stringify(options) });
}

async function init(options) {
  if (options.telemetryMode !== undefined && !['full', 'limited', 'off'].includes(options.telemetryMode)) {
    throw new Error('telemetryMode must be full, limited, or off');
  }
  if (options.anonymizeLogging !== undefined && typeof options.anonymizeLogging !== 'boolean') {
    throw new Error('anonymizeLogging must be a boolean');
  }
  if (proc && proc.exitCode === null) {
    throw new Error('The SDK is already started; call shutdown before initializing again');
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(`Platform ${process.platform} is not supported by the SDK`);
  }
  const { api_url, apiUrl, dev } = options;
  options.api_url = api_url ?? apiUrl ?? 'https://api.example.com';
  if (!dev && !String(options.api_url).startsWith('https')) {
    throw new Error(`apiUrl must be an https url, got: ${options.api_url}`);
  }
  if (options.restartOnError === undefined) options.restartOnError = true;
  const version = readVersion();
  lastOptions = version ? { ...options, sdkVersion: version } : { ...options };
  await doInit(lastOptions);
  return null;
}

async function shutdown() {
  const result = await sendCommand('shutdown');
  const current = proc;
  if (current) {
    await new Promise((resolve) => {
      if (current.exitCode !== null) return resolve();
      current.once('close', () => resolve());
      setTimeout(() => { if (!current.killed) current.kill(); resolve(); }, SHUTDOWN_KILL_MS);
    });
  }
  return result;
}

const dumpAXTree = (procName) => sendCommand('dumpAXTree', { procName });
const dumpAllApplications = () => sendCommand('dumpAllApplications', {});
const startRecording = (config) => sendCommand('startRecording', { config: JSON.stringify(config) });
const stopRecording = ({ windowId }) => sendCommand('stopRecording', { windowId });
const pauseRecording = ({ windowId }) => sendCommand('pauseRecording', { windowId });
const resumeRecording = ({ windowId }) => sendCommand('resumeRecording', { windowId });
const sendChatMessage = ({ windowId, message, to = 'everyone', pin = false }) =>
  sendCommand('sendChatMessage', { windowId, message, to, pin });
const uploadRecording = ({ windowId }) => sendCommand('uploadRecording', { windowId });
const prepareDesktopAudioRecording = (config) => sendCommand('prepareDesktopAudioRecording', { ...config });
const listDevices = () => sendCommand('listDevices');
const setDesktopAudioDevice = (id, dir) => sendCommand('setDesktopAudioDevice', { id, dir });
const requestPermission = (permission) => sendCommand('requestPermission', { permission });
const testUnexpectedShutdown = () => sendCommand('unexpectedShutdown', {});

function addEventListener(type, callback) { listeners.push({ type, callback }); }
function removeEventListener(type, callback) {
  const i = listeners.findIndex((l) => l.type === type && l.callback === callback);
  if (i !== -1) listeners.splice(i, 1);
}
function removeAllEventListeners() { listeners.length = 0; }

const MeetingSdk = {
  init, shutdown, startRecording, stopRecording, pauseRecording, resumeRecording, sendChatMessage,
  uploadRecording, prepareDesktopAudioRecording, listDevices, setDesktopAudioDevice, requestPermission,
  addEventListener, removeEventListener, removeAllEventListeners, testUnexpectedShutdown,
};

// Test hooks: run the detection rules and the detector on recorded data without a live app.
const _debug = (command, params) => sendCommand(command, params);

module.exports = {
  ...MeetingSdk, dumpAXTree, dumpAllApplications, _debug,
  default: MeetingSdk, __esModule: true,
  ENV_PREFIX,
};
