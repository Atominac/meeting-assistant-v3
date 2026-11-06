const root = document.getElementById('root');
let S = null, timer = null, ask = null, auth = { mode: 'login', busy: false, error: '', showServer: false };

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLATFORM = { 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', desktop: 'Desktop audio' };
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`; };
const inMin = (d) => { const m = Math.round((new Date(d) - Date.now()) / 60000); return m <= 0 ? 'now' : m < 60 ? `in ${m} min` : new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };

const header = (dot, text, right = '') => `<div class="row"><img class="logo" src="logo.png" alt=""><div class="grow ellip"><h1>${esc(text)}</h1></div><span class="dot ${dot}"></span>${right}<button class="icon" data-act="close" title="Close (Esc)">✕</button></div>`;

function view() {
  if (!S.signedIn) {
    const up = auth.mode === 'signup';
    return `<div class="stack">
      ${header('gray', up ? 'Create your account' : 'Meeting Assistant')}
      ${up ? '<div class="dim small">Same account as the web app.</div>' : `<div class="dim small">Log in with your Meeting Assistant account.</div>`}
      ${up ? '<input id="name" placeholder="Name" autocomplete="name">' : ''}
      <input id="email" type="email" placeholder="Email" autocomplete="email" autofocus>
      <input id="password" type="password" placeholder="Password${up ? ' (8+ characters)' : ''}" autocomplete="${up ? 'new-password' : 'current-password'}">
      ${up ? '<input id="invite" placeholder="Invite code (if you were given one)" autocomplete="off">' : ''}
      ${auth.showServer ? `<input id="server" value="${esc(S.serverUrl)}" placeholder="Server URL">` : ''}
      ${auth.error || S.notice ? `<div class="warn">${esc(auth.error || S.notice)}</div>` : ''}
      <div class="row"><button class="link" data-act="server">${auth.showServer ? 'Hide server' : 'Server…'}</button><span class="grow"></span><button class="link" data-act="quit">Quit</button><button class="primary" data-act="submit" ${auth.busy ? 'disabled' : ''}>${auth.busy ? 'Please wait…' : up ? 'Sign up' : 'Log in'}</button></div>
      <div class="dim small" style="text-align:center">${up ? 'Have an account?' : 'New here?'} <button class="link" data-act="mode">${up ? 'Log in' : 'Create an account'}</button></div>
    </div>`;
  }

  if (ask) {
    return `<div class="stack">${header('orange', 'Before you record')}
      <div class="card small">Recording captures everyone's voice and video and saves it to your team's workspace. <b>Tell the participants</b> (and get their agreement where the law or your policy requires it) before you start.</div>
      <div class="row"><button data-act="ask-no">Not now</button><span class="grow"></span><button class="primary" data-act="ask-yes">I'll tell them · Record</button></div></div>`;
  }

  const missing = Object.entries(S.perms).filter(([, v]) => v !== 'granted');
  const active = S.meetings.find((m) => ['recording', 'paused', 'stopping', 'starting'].includes(m.phase));
  const detected = S.meetings.filter((m) => m.phase === 'detected' || m.phase === 'ignored'); // ignored: no pop-up, but still recordable by hand
  const saved = S.meetings.find((m) => m.phase === 'saved');
  const notice = S.notice ? `<div class="warn">${esc(S.notice)}</div>` : '';

  if (active) {
    const busy = active.phase !== 'recording' && active.phase !== 'paused', paused = active.phase === 'paused';
    const elapsed = active.startedAt ? mmss((paused ? active.pausedAt : Date.now()) - active.startedAt) : '';
    return `<div class="stack">
      ${header(busy || paused ? 'orange' : 'red', active.phase === 'starting' ? 'Starting…' : active.phase === 'stopping' ? 'Finishing…' : paused ? 'Paused' : 'Recording', `<span class="timer dim nodrag" id="timer">${elapsed}</span>`)}
      <div class="card"><div class="title ellip">${esc(active.title)}</div><div class="dim small">${esc(PLATFORM[active.platform] || 'Meeting')}</div>
        ${active.phase === 'recording' ? `<div class="live">${esc(active.line) || '<span class="dim">Listening…</span>'}</div>` : ''}</div>
      ${notice}
      <div class="row"><span class="grow dim small">${active.phase === 'recording' ? 'Live captions' : paused ? 'Nothing is being recorded' : ''}</span>${busy ? '<span class="spin"></span>' : `<button data-act="${paused ? 'resume' : 'pause'}" data-id="${esc(active.windowId)}">${paused ? 'Resume' : 'Pause'}</button><button class="stop" data-act="stop" data-id="${esc(active.windowId)}">Stop</button>`}</div>
    </div>`;
  }

  if (detected.length) {
    return `<div class="stack">
      ${header('', 'Meeting detected')}
      ${detected.map((m) => `<div class="card"><div class="dim small">${esc(PLATFORM[m.platform] || 'Meeting')}${m.phase === 'ignored' ? ' · ignored' : ''}</div><div class="title ellip">${esc(m.title)}</div>
          <div class="row" style="margin-top:10px"><span class="grow dim small">${missing.length ? 'Finish setup below to record.' : m.phase === 'ignored' ? 'Not being recorded.' : 'Not recording yet.'}</span><button class="primary" data-act="start" data-id="${esc(m.windowId)}" ${missing.length ? 'disabled' : ''}>Record</button></div></div>`).join('')}
      ${notice}${missing.length ? setup() : ''}
    </div>`;
  }

  if (saved) {
    return `<div class="stack">${header('', 'Saved')}
      <div class="card"><div class="title ellip">${esc(saved.title)}</div><div class="dim small">Processing the video, transcript and notes. This takes a few minutes.</div></div>
      <div class="row"><span class="grow"></span><button class="primary" data-act="open" data-path="/meeting/${esc(saved.saved)}">Open recording</button></div></div>`;
  }

  // idle
  return `<div class="stack">
    ${header(missing.length ? 'orange' : '', missing.length ? 'Setup needed' : 'Ready')}
    ${missing.length ? setup() : `<div class="dim small ellip">${S.next ? `Next: ${esc(S.next.title)} · ${inMin(S.next.start)}` : 'I’ll tell you when a Zoom or Meet call starts.'}</div>`}
    ${notice}
    <div class="row"><span class="grow"></span><button class="link" data-act="open" data-path="">Dashboard</button></div>
    <div class="row dim small"><span class="grow ellip" title="${esc(S.user?.email)}">${esc(S.user?.email || '')}</span><button class="link" data-act="logout">Sign out</button></div>
  </div>`;
}

const setup = () => `<div class="card">
  ${Object.entries(S.perms).map(([k, v]) => `<div class="perm"><span>${{ accessibility: 'Accessibility', microphone: 'Microphone', 'screen-capture': 'Screen recording' }[k]}</span><span class="${v === 'granted' ? 'ok' : 'bad'}">${v === 'granted' ? 'Allowed' : v === 'denied' ? 'Denied' : 'Needed'}</span></div>`).join('')}
  <div class="row" style="margin-top:8px"><button class="primary" data-act="grant">Grant access</button><button class="link" data-act="settings">Open Settings</button></div>
  <div class="dim small" style="margin-top:6px">After enabling Screen Recording, macOS needs the app restarted. <button class="link" data-act="relaunch">Restart</button></div></div>`;

function dock() {
  const rec = S.meetings.find((m) => m.phase === 'recording');
  const paused = S.meetings.find((m) => m.phase === 'paused');
  const busy = S.meetings.some((m) => m.phase === 'starting' || m.phase === 'stopping');
  const detected = S.meetings.filter((m) => m.phase === 'detected');
  const badge = rec ? 'red' : paused ? 'orange' : detected.length ? '' : S.notice || (S.signedIn && Object.values(S.perms).some((v) => v !== 'granted')) ? 'orange' : null;
  let label = '';
  if (rec) label = `<span class="dot red"></span><span class="timer" id="timer">${mmss(Date.now() - rec.startedAt)}</span><span class="dim">Recording</span>`;
  else if (paused) label = '<span class="dot"></span><span class="dim">Paused</span>';
  else if (busy) label = '<span class="spin"></span>Working…';
  else if (detected.length) label = `<span class="dot"></span>Meeting detected`;
  else if (S.notice) label = `<span class="ellip">${esc(S.notice)}</span>`;
  return `<div class="dock" title="Meeting Assistant">${S.bubble && label ? `<div class="bubble">${label}</div>` : ''}<div class="tab"><img src="logo.png" alt="Meeting Assistant">${badge !== null ? `<span class="badge ${badge}"></span>` : ''}</div></div>`;
}

function render() {
  if (!S) return;
  const focused = document.activeElement?.id;
  const saved = Object.fromEntries([...root.querySelectorAll('input')].map((i) => [i.id, i.value]));
  root.innerHTML = S.open ? `<div class="panel">${view()}</div>` : dock();
  for (const [id, v] of Object.entries(saved)) { const el = document.getElementById(id); if (el && v) el.value = v; }
  if (focused) document.getElementById(focused)?.focus();
  clearInterval(timer);
  const rec = S.meetings.find((m) => m.phase === 'recording');
  if (rec) timer = setInterval(() => { const t = document.getElementById('timer'); if (t) t.textContent = mmss(Date.now() - rec.startedAt); }, 1000);
  if (S.open) requestAnimationFrame(() => window.widget.resize(root.querySelector('.panel').offsetHeight));
}

root.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const { act, id, path } = el.dataset;
  if (act === 'start') { if (!S.consent) { ask = { kind: 'start', id }; return render(); } window.widget.start(id); }
  else if (act === 'ask-no') { ask = null; render(); }
  else if (act === 'ask-yes') { const a = ask; ask = null; await window.widget.consent(); window.widget.start(a.id); }
  else if (act === 'stop') window.widget.stop(id);
  else if (act === 'pause') window.widget.pause(id);
  else if (act === 'resume') window.widget.resume(id);
  else if (act === 'close') window.widget.setOpen(false);
  else if (act === 'grant') window.widget.grant();
  else if (act === 'settings') window.widget.openSettings('Privacy_ScreenCapture');
  else if (act === 'relaunch') window.widget.relaunch();
  else if (act === 'open') window.widget.openDashboard(path);
  else if (act === 'quit') window.widget.quit();
  else if (act === 'logout') window.widget.logout();
  else if (act === 'mode') { auth = { ...auth, mode: auth.mode === 'login' ? 'signup' : 'login', error: '' }; render(); }
  else if (act === 'server') { auth.showServer = !auth.showServer; render(); }
  else if (act === 'submit') {
    const v = (id) => document.getElementById(id)?.value.trim() || '';
    const fields = { name: v('name'), email: v('email'), password: document.getElementById('password').value, inviteCode: v('invite'), serverUrl: v('server') || S.serverUrl };
    if (!fields.email || !fields.password) { auth.error = 'Enter your email and password.'; return render(); }
    auth = { ...auth, busy: true, error: '' }; render();
    try { await (auth.mode === 'signup' ? window.widget.signup(fields) : window.widget.login(fields)); auth.error = ''; }
    catch (err) { auth.error = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
    auth.busy = false; render();
  }
});
root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && document.getElementById('password')) root.querySelector('[data-act="submit"]')?.click(); });
// The tab: a click opens the panel; dragging moves it up/down the screen edge.
let drag = null;
root.addEventListener('pointerdown', (e) => {
  if (!S || S.open) return;
  drag = { y: e.screenY, moved: false };
  try { root.setPointerCapture(e.pointerId); } catch { /* synthetic pointer: nothing to capture */ }
  window.widget.dragStart();
});
root.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.screenY - drag.y;
  if (!drag.moved && Math.abs(dy) < 4) return;
  drag.moved = true; window.widget.dragMove(dy);
});
root.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  d.moved ? window.widget.dragEnd() : window.widget.setOpen(true);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S?.open) window.widget.setOpen(false); });
window.widget.onState((s) => { S = s; render(); });
