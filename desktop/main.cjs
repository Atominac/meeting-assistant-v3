// Meeting Assistant desktop recorder. Runs in the menu bar and shows an always-on-top widget.
// It holds no recording keys: the server creates uploads and hands this app a short-lived upload token.
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, safeStorage, screen, shell, dialog } = require('electron');
// Own settings folder, so this app keeps its own login, saved server address and single-instance lock.
app.setPath('userData', require('path').join(app.getPath('appData'), 'Meeting Assistant V3'));
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const MeetingSdk = require('meeting-desktop-sdk');
// Debug trace (stdout isn't visible when launched via `open`): desktop/debug.log
const DEBUG_LOG = path.join(__dirname, 'debug.log');
const dlog = (...a) => { try { fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`); } catch {} };


const DEFAULT_SERVER = process.env.SERVER_URL || 'http://localhost:3002';
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const REQUIRED = ['accessibility', 'microphone', 'screen-capture'];
const IS_WIN = process.platform === 'win32';

let cfg = { serverUrl: DEFAULT_SERVER, setupStarted: false, consent: false, tabY: null };
let token = null;
let widget, tray;
let open = false; // panel expanded? (starts closed: only the small tab is on screen)
let bubbleUntil = 0; // show the label next to the tab until this time
let contentH = 220; // height of the panel's content, reported by the renderer
let dragBase = 0;
const TAB = 56, PANEL_W = 340, BUBBLE_W = 232, EDGE_GAP = 12;
let user = null;
let upcoming = [];
let sdkUrl = null; // region the SDK is currently initialised for
const perms = {};
// Windows has no Accessibility / Screen Recording / Microphone consent screens (the SDK reports them as granted).
if (IS_WIN) for (const p of REQUIRED) perms[p] = 'granted';
const meetings = new Map(); // windowId -> { windowId, title, url, platform, phase, serverId, startedAt, line, saved }
let askToRecord = true; // account preference (web Settings): pop up "Record this meeting?" when a call is detected
let promptWin = null;
const promptQueue = [];
let promptCurrent = null; // { id, timer }
const PROMPT_W = 360;
let notice = '';

// ---------- config ----------
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    cfg = { ...cfg, ...raw.cfg };
    if (raw.token) token = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : Buffer.from(raw.token, 'base64').toString();
  } catch { /* first run */ }
}
function saveConfig() {
  const enc = token ? (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token)).toString('base64') : null;
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify({ cfg, token: enc }), { mode: 0o600 });
}

// ---------- server ----------
async function server(method, p, body) {
  const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { signedOut('You were signed out. Please log in again.'); }
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  return data;
}

function applyUser(u) { user = u; askToRecord = u?.prefs?.askToRecord !== false; }
function signedOut(msg) { token = null; user = null; askToRecord = true; upcoming = []; saveConfig(); notice = msg || ''; updateTray(); push(); }

// ---------- state pushed to the widget ----------
function snapshot() {
  const list = [...meetings.values()];
  return {
    signedIn: !!token, user, serverUrl: cfg.serverUrl, askToRecord, consent: cfg.consent, open, bubble: bubbleActive(), notice,
    perms: Object.fromEntries(REQUIRED.map((p) => [p, perms[p] || 'not_requested'])), setupStarted: cfg.setupStarted,
    meetings: list.map(({ windowId, title, platform, phase, startedAt, pausedAt, line, saved }) => ({ windowId, title, platform, phase, startedAt, pausedAt, line, saved })),
    next: upcoming.find((e) => new Date(e.end) > new Date()) || null,
  };
}
const push = () => { if (!widget || widget.isDestroyed()) return; layout(); widget.webContents.send('state', snapshot()); };
const setNotice = (m) => { notice = m; if (m) bubbleUntil = Date.now() + 8000; push(); if (m) setTimeout(() => { if (notice === m) { notice = ''; push(); } }, 8000); };
const allGranted = () => REQUIRED.every((p) => perms[p] === 'granted');

// The SDK uploads to this app's own server, so it starts once we know the server address (at log-in).
async function initSdk() {
  const apiUrl = cfg.serverUrl && `${cfg.serverUrl}/api/sdk`;
  if (!apiUrl || sdkUrl === apiUrl) return;
  try {
    if (sdkUrl) await MeetingSdk.shutdown();
    await MeetingSdk.init({ apiUrl, dev: !apiUrl.startsWith('https'), acquirePermissionsOnStartup: [] });
    sdkUrl = apiUrl;
    // Re-check permissions we already asked about (no prompt if already answered).
    if (cfg.setupStarted) for (const p of REQUIRED) MeetingSdk.requestPermission(p).catch(() => {});
  } catch (e) { setNotice(`Recording engine failed to start: ${e.message}`); }
}

// ---------- recording ----------
async function startRecording(windowId) {
  const m = meetings.get(windowId);
  if (!m || m.phase === 'starting' || m.phase === 'recording') return;
  if (!cfg.consent) return setNotice('Confirm the recording notice first.');
  m.phase = 'starting'; push();
  if (windowId.startsWith('demo-')) return demoRecording(m); // MA_DEMO preview only
  try {
    const r = await server('POST', '/api/desktop/meetings', { title: m.callTitle, url: m.url, platform: m.platform });
    m.serverId = r.meetingId;
    if (r.title) m.title = r.title;
    await MeetingSdk.startRecording({ windowId, uploadToken: r.uploadToken });
    // phase flips to "recording" on the SDK's recording-started event
  } catch (e) {
    m.phase = 'detected'; setNotice(e.message); console.error(e);
  }
}

async function pauseRecording(windowId) {
  const m = meetings.get(windowId);
  if (!m || m.phase !== 'recording') return;
  try { if (!windowId.startsWith('demo-')) await MeetingSdk.pauseRecording({ windowId }); } catch (e) { return setNotice(e.message); }
  m.phase = 'paused'; m.pausedAt = Date.now(); push(); updateTray();
}
async function resumeRecording(windowId) {
  const m = meetings.get(windowId);
  if (!m || m.phase !== 'paused') return;
  try { if (!windowId.startsWith('demo-')) await MeetingSdk.resumeRecording({ windowId }); } catch (e) { return setNotice(e.message); }
  m.startedAt += Date.now() - m.pausedAt; // the timer skips the time spent paused
  m.phase = 'recording'; m.pausedAt = null; push(); updateTray();
}

async function stopRecording(windowId) {
  const m = meetings.get(windowId);
  if (!m || (m.phase !== 'recording' && m.phase !== 'paused')) return;
  m.phase = 'stopping'; push();
  if (windowId.startsWith('demo-')) return setTimeout(() => { m.phase = 'saved'; m.saved = 'demo1'; push(); }, 1200);
  try { await MeetingSdk.stopRecording({ windowId }); } catch (e) { setNotice(e.message); }
}

// MA_DEMO=1 npm run demo: simulates a detected meeting so the widget can be previewed without a call.
function demoMeeting() {
  REQUIRED.forEach((p) => { perms[p] = 'granted'; });
  meetings.set('demo-1', { windowId: 'demo-1', phase: 'detected', title: 'Weekly sync', platform: 'google-meet' });
  announce();
  maybePrompt('demo-1');
}
function demoRecording(m) {
  const lines = ['Priya Shah: Thanks everyone for joining, let us start with pricing.', 'Marcus Lee: I ran the numbers and we keep margin above sixty percent.', 'Elena Rossi: Agreed, but sales wants an annual discount.'];
  setTimeout(() => {
    m.phase = 'recording'; m.startedAt = Date.now(); m.line = ''; push(); updateTray();
    if (m.endAfterStart) stopRecording(m.windowId);
    if (process.env.MA_DEMO_END) setTimeout(() => onMeetingClosed(m.windowId), Number(process.env.MA_DEMO_END) * 1000); // simulate the call ending
  }, 800);
  lines.forEach((l, i) => setTimeout(() => { if (m.phase === 'recording') { m.line = l; push(); } }, 2200 + i * 2500));
}

// ---------- "Record this meeting?" pop-up ----------
// Shown whenever a call is detected (if the account preference is on). One at a time; extra calls wait their turn.
function maybePrompt(windowId) {
  const m = meetings.get(windowId);
  if (!m || m.phase !== 'detected' || m.prompted || !token || !askToRecord || !allGranted()) return;
  m.prompted = true;
  promptQueue.push(windowId);
  nextPrompt();
}
function nextPrompt() {
  if (promptCurrent || !promptQueue.length) return;
  const id = promptQueue.shift();
  const m = meetings.get(id);
  if (!m || m.phase !== 'detected') return nextPrompt();
  // No answer after a minute: the pop-up goes away, the call stays available on the tab (nothing is recorded).
  promptCurrent = { id, timer: setTimeout(() => closePrompt(id), 60_000) };
  showPrompt(m);
}
function closePrompt(id) {
  if (promptCurrent?.id !== id) return;
  clearTimeout(promptCurrent.timer);
  promptCurrent = null;
  if (promptWin && !promptWin.isDestroyed()) promptWin.hide();
  nextPrompt();
}
function showPrompt(m) {
  const wa = screen.getPrimaryDisplay().workArea;
  if (!promptWin || promptWin.isDestroyed()) {
    promptWin = new BrowserWindow({
      width: PROMPT_W, height: 150, frame: false, transparent: true, resizable: false, hasShadow: true, skipTaskbar: true, show: false,
      alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false, type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    promptWin.setAlwaysOnTop(true, 'screen-saver');
    if (!IS_WIN) promptWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    promptWin.loadFile(path.join(__dirname, 'renderer', 'prompt.html'));
  }
  promptWin.setPosition(wa.x + wa.width - PROMPT_W - 12, wa.y + 12);
  const send = () => { promptWin.webContents.send('prompt', { windowId: m.windowId, title: m.title, platform: m.platform, needsConsent: !cfg.consent }); promptWin.showInactive(); };
  promptWin.webContents.isLoading() ? promptWin.webContents.once('did-finish-load', send) : send();
}
function answerPrompt({ windowId, answer, consent }) {
  const m = meetings.get(windowId);
  if (!m) return closePrompt(windowId);
  if (answer === 'record') {
    if (!cfg.consent) { if (!consent) return; cfg.consent = true; saveConfig(); } // one-time "I'll tell participants" confirmation
    closePrompt(windowId);
    startRecording(windowId);
  } else {
    if (m.phase === 'detected') m.phase = 'ignored'; // Ignore: don't record, don't ask again for this call
    closePrompt(windowId);
    push();
  }
}
const askAboutDetected = () => { for (const m of meetings.values()) maybePrompt(m.windowId); };

// The call ended (or its window was closed): stop recording by ourselves.
function onMeetingClosed(id) {
  dlog('meeting-closed', id, 'phase:', meetings.get(id)?.phase);
  // Keep the "already recorded" mark a little longer: the SDK can re-report the same call right after stop.
  setTimeout(() => { finishedCalls.delete(id); for (const [k, v] of finishedCalls) if (v === id) finishedCalls.delete(k); }, 90_000);
  const m = meetings.get(id);
  if (!m) return;
  if (promptCurrent?.id === id) closePrompt(id);
  if (m.phase === 'detected' || m.phase === 'ignored' || m.phase === 'saved') meetings.delete(id);
  else if (m.phase === 'recording' || m.phase === 'paused') { m.endedByCall = true; stopRecording(id); }
  else if (m.phase === 'starting') m.endAfterStart = true; // recording had not begun yet: stop the moment it does
  push();
}

// Calls we already recorded and saved: if the call is still going on, don't announce it again once its card is gone.
const finishedCalls = new Map(); // call id or url -> window id
const callKey = (w) => w.url || '';

function wireSdk() {
  dlog('wireSdk: code with debug logging is running');
  MeetingSdk.addEventListener('permission-status', ({ permission, status }) => { perms[permission] = status; push(); askAboutDetected(); });
  MeetingSdk.addEventListener('meeting-detected', ({ window: w }) => {
    dlog('meeting-detected', { id: w.id, url: w.url, title: w.title, platform: w.platform }, 'known phase:', meetings.get(w.id)?.phase, 'finished:', [...finishedCalls.keys()], 'all:', [...meetings.values()].map((x) => `${x.windowId}:${x.phase}`));
    if (finishedCalls.has(w.id) || (callKey(w) && finishedCalls.has(callKey(w)))) return;
    const known = meetings.get(w.id);
    if (known && !['detected', 'ignored'].includes(known.phase)) { if (w.url) known.url = w.url; return; } // already recording / stopping / saved: not a new meeting
    if (!known) meetings.set(w.id, { windowId: w.id, phase: 'detected' });
    Object.assign(meetings.get(w.id), { title: w.title || prettyPlatform(w.platform), callTitle: w.title, url: w.url, platform: w.platform });
    announce();
    maybePrompt(w.id);
  });
  MeetingSdk.addEventListener('meeting-updated', ({ window: w }) => {
    dlog('meeting-updated', { id: w.id, url: w.url, title: w.title });
    const m = meetings.get(w.id); if (!m) return;
    if (w.title) {
      m.callTitle = w.title;
      if (m.phase === 'detected') m.title = w.title;
      if (m.serverId && (m.phase === 'recording' || m.phase === 'paused')) server('PATCH', `/api/desktop/meetings/${m.serverId}`, { title: w.title }).catch(() => {});
    }
    if (w.url) m.url = w.url;
    push();
  });
  MeetingSdk.addEventListener('meeting-closed', ({ window: w }) => onMeetingClosed(w.id));
  MeetingSdk.addEventListener('recording-started', ({ window: w }) => {
    dlog('recording-started', w.id);
    const m = meetings.get(w.id); if (!m) return;
    m.phase = 'recording'; m.startedAt = Date.now(); m.line = ''; finishedCalls.set(w.id, w.id); if (m.url || w.url) finishedCalls.set(m.url || w.url, w.id); push(); updateTray();
    if (m.endAfterStart) stopRecording(w.id); // the call ended while we were starting
  });
  MeetingSdk.addEventListener('recording-ended', async ({ window: w }) => {
    dlog('recording-ended', w.id);
    const m = meetings.get(w.id); if (!m) return;
    m.phase = 'saved'; m.saved = m.serverId; finishedCalls.set(w.id, w.id); if (m.url) finishedCalls.set(m.url, w.id); push(); updateTray();
    if (m.serverId) await server('POST', `/api/desktop/meetings/${m.serverId}/ended`, { title: m.callTitle, participants: participantList(m) }).catch(() => {});
    setTimeout(() => { const x = meetings.get(w.id); if (x?.phase === 'saved') { meetings.delete(w.id); push(); } }, 45_000);
  });
  MeetingSdk.addEventListener('realtime-event', ({ window: w, event, data }) => {
    const m = meetings.get(w.id); const inner = data?.data ?? data;
    if (m && event.startsWith('participant_events.')) trackParticipant(m, event.split('.')[1], inner);
  });
  MeetingSdk.addEventListener('error', ({ message }) => setNotice(message));
  MeetingSdk.addEventListener('shutdown', ({ code }) => console.log('SDK exited', code));
}
// Everyone in the call, from the join/leave events (so people who never speak are included).
function trackParticipant(m, kind, inner) {
  const p = inner?.participant;
  if (!p?.id && p?.id !== 0) return;
  m.people ||= new Map();
  const at = inner.timestamp?.absolute || new Date().toISOString();
  const cur = m.people.get(String(p.id)) || { id: String(p.id), name: '', isHost: false, joinedAt: null, leftAt: null };
  if (p.name) cur.name = p.name;
  if (p.is_host) cur.isHost = true;
  if (kind === 'join') { cur.joinedAt ||= at; cur.leftAt = null; }
  else if (kind === 'leave') cur.leftAt = at;
  m.people.set(cur.id, cur);
  clearTimeout(m.peopleTimer);
  m.peopleTimer = setTimeout(() => { if (m.serverId) server('PATCH', `/api/desktop/meetings/${m.serverId}`, { participants: participantList(m) }).catch(() => {}); }, 3000);
}
const participantList = (m) => [...(m.people?.values() || [])];
const prettyPlatform = (p) => ({ 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' }[p] || 'Meeting');

// ---------- widget window ----------
// One frameless window. Closed: a small tab docked to the right screen edge (draggable up and down only).
// Needs attention (meeting detected / recording): the tab grows a label. Open: the full panel, anchored to the same edge.
const bubbleActive = () => !open && ([...meetings.values()].some((m) => ['recording', 'paused', 'starting', 'stopping'].includes(m.phase)) || Date.now() < bubbleUntil);

function layout() {
  if (!widget || widget.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const right = wa.x + wa.width;
  const clampY = (y, h) => Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - h - 8));
  const tabY = clampY(cfg.tabY ?? wa.y + Math.round(wa.height * 0.35), TAB);
  let b;
  if (open) { const h = Math.min(Math.max(contentH, 80), wa.height - 16); b = { x: right - PANEL_W - EDGE_GAP, y: clampY(tabY, h), width: PANEL_W, height: h }; }
  else { const w = bubbleActive() ? BUBBLE_W : TAB; b = { x: right - w, y: tabY, width: w, height: TAB }; }
  const cur = widget.getBounds();
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) { widget.setBounds(b, false); widget.invalidateShadow?.(); }
}

function createWidget() {
  widget = new BrowserWindow({
    width: TAB, height: TAB, frame: false, transparent: true, resizable: false, hasShadow: true, skipTaskbar: true, show: false,
    alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false, type: process.platform === 'darwin' ? 'panel' : undefined,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  widget.setAlwaysOnTop(true, 'screen-saver');
  if (!IS_WIN) widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  widget.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => { layout(); widget.showInactive(); push(); });
  screen.on('display-metrics-changed', layout);
  widget.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  widget.webContents.on('will-navigate', (e) => e.preventDefault());
}

// A meeting appeared: label the tab for a few seconds (the panel stays closed unless the user opens it).
function announce() {
  if (!widget) return;
  if (!widget.isVisible()) widget.showInactive();
  bubbleUntil = Date.now() + 12_000;
  setTimeout(push, 12_100);
  push();
}
const setOpen = (on) => { open = !!on; if (open) bubbleUntil = 0; push(); };

// ---------- tray ----------
function trayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'renderer', 'logo.png')).resize(IS_WIN ? { width: 16, height: 16 } : { width: 18, height: 18 });
}
function updateTray() {
  if (!tray) return;
  const live = [...meetings.values()].find((m) => m.phase === 'recording' || m.phase === 'paused');
  const rec = live?.phase === 'recording', paused = live?.phase === 'paused';
  tray.setTitle(rec ? ' ● Recording' : paused ? ' ❚❚ Paused' : '');
  tray.setToolTip(rec ? 'Meeting Assistant: recording' : paused ? 'Meeting Assistant: paused' : 'Meeting Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: rec ? '● Recording' : paused ? '❚❚ Paused' : 'Meeting Assistant', enabled: false },
    ...(live ? [{ label: paused ? 'Resume recording' : 'Pause recording', click: () => (paused ? resumeRecording(live.windowId) : pauseRecording(live.windowId)) }] : []),
    { label: 'Open dashboard', click: () => shell.openExternal(cfg.serverUrl), enabled: !!token },
    { label: 'Open panel', click: () => { widget.showInactive(); setOpen(true); } },
    { label: widget?.isVisible() ? 'Hide tab' : 'Show tab', click: () => { widget.isVisible() ? widget.hide() : widget.showInactive(); updateTray(); } },
    { label: 'Ask me when a meeting starts', type: 'checkbox', checked: askToRecord, click: (i) => setAsk(i.checked), enabled: !!token },
    ...(app.isPackaged ? [{ label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) }] : []),
    { type: 'separator' },
    { label: user ? `Sign out (${user.email})` : 'Sign out', click: logout, enabled: !!token },
    { label: 'Quit', click: quit },
  ]));
}
async function quit() {
  if ([...meetings.values()].some((m) => m.phase === 'recording' || m.phase === 'paused')) {
    const { response } = await dialog.showMessageBox({ type: 'warning', message: 'A meeting is being recorded.', detail: 'Quitting now may lose the end of the recording.', buttons: ['Keep recording', 'Quit anyway'], defaultId: 0, cancelId: 0 });
    if (response === 0) return;
  }
  app.exit(0);
}
async function setAsk(on) {
  askToRecord = !!on; updateTray(); push(); // optimistic; the server is the source of truth
  try { const r = await server('PATCH', '/api/auth/prefs', { askToRecord: !!on }); askToRecord = r.prefs.askToRecord; }
  catch (e) { askToRecord = !on; setNotice(e.message); }
  updateTray(); push();
}

// ---------- IPC ----------
async function authenticate(kind, fields) {
  const serverUrl = String(fields.serverUrl || DEFAULT_SERVER).trim().replace(/\/$/, '');
  const res = await fetch(`${serverUrl}/api/auth/${kind}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fields.name, email: fields.email, password: fields.password, inviteCode: fields.inviteCode, client: 'desktop', deviceName: os.hostname().replace(/\.local$/, '') }),
  }).catch(() => { throw new Error(`Can't reach ${serverUrl}`); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server said ${res.status}`);
  cfg.serverUrl = serverUrl;
  token = data.token; applyUser(data.user); notice = ''; saveConfig(); updateTray();
  await initSdk(); refreshUpcoming(); push(); askAboutDetected();
}
ipcMain.handle('login', (_e, f) => authenticate('login', f));
ipcMain.handle('signup', (_e, f) => authenticate('signup', f));
async function logout() {
  if ([...meetings.values()].some((m) => m.phase === 'recording' || m.phase === 'paused')) { setNotice('Stop recording before signing out.'); return; }
  try { await server('POST', '/api/auth/logout'); } catch { /* offline: still sign out locally */ }
  signedOut('');
}
ipcMain.handle('logout', logout);
// Handlers must not return live objects (timers etc.): IPC can only clone plain data.
ipcMain.handle('start', async (_e, id) => { await startRecording(id); });
ipcMain.handle('stop', async (_e, id) => { await stopRecording(id); });
ipcMain.handle('pause', async (_e, id) => { await pauseRecording(id); });
ipcMain.handle('resume', async (_e, id) => { await resumeRecording(id); });
ipcMain.handle('prompt-answer', (_e, a) => { answerPrompt(a); });
ipcMain.handle('prompt-resize', (_e, h) => { if (promptWin && !promptWin.isDestroyed()) promptWin.setContentSize(PROMPT_W, Math.max(80, Math.min(Math.ceil(h), 400)), false); });
ipcMain.handle('consent', () => { cfg.consent = true; saveConfig(); push(); });
ipcMain.handle('set-open', (_e, on) => { setOpen(on); });
// Dragging the tab: the window follows the pointer vertically only, so it stays on the right edge.
ipcMain.handle('drag-start', () => { dragBase = widget.getBounds().y; });
ipcMain.handle('drag-move', (_e, dy) => { cfg.tabY = dragBase + Number(dy); layout(); });
ipcMain.handle('drag-end', () => { cfg.tabY = widget.getBounds().y; saveConfig(); });
ipcMain.handle('grant', async () => {
  cfg.setupStarted = true; saveConfig();
  for (const p of REQUIRED) { try { await MeetingSdk.requestPermission(p); } catch (e) { console.error(p, e.message); } }
});
ipcMain.handle('open-settings', (_e, pane) => shell.openExternal(IS_WIN ? 'ms-settings:privacy-microphone' : `x-apple.systempreferences:com.apple.preference.security?${pane}`));
ipcMain.handle('open-dashboard', (_e, p) => shell.openExternal(`${cfg.serverUrl}${p || ''}`));
ipcMain.handle('relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('resize', (_e, h) => { contentH = Math.ceil(Number(h) || 0); if (open) layout(); });
ipcMain.handle('quit', quit);

async function refreshUpcoming() {
  if (!token) return;
  try {
    const r = await server('GET', '/api/desktop/upcoming'); upcoming = r.events;
    const me = await server('GET', '/api/auth/me'); // also keeps the "ask before recording" setting in sync with the web app
    applyUser(me.user);
    await initSdk(); updateTray();
    push();
  } catch { /* offline */ }
}

// ---------- boot ----------
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => widget?.showInactive());
app.on('window-all-closed', (e) => e.preventDefault()); // lives in the menu bar (Mac) / system tray (Windows)

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();
  if (IS_WIN) app.setAppUserModelId('com.gohighlevel.meetingassistant');
  loadConfig();
  createWidget();
  tray = new Tray(trayIcon());
  updateTray();
  wireSdk();
  await initSdk(); // only if already logged in; otherwise it starts right after log-in
  if (process.env.MA_DEMO) setTimeout(demoMeeting, Number(process.env.MA_DEMO_DELAY) || 4000);
  refreshUpcoming();
  setInterval(refreshUpcoming, 2 * 60_000);
  setInterval(push, 30_000); // keeps "in 12 min" fresh
});
