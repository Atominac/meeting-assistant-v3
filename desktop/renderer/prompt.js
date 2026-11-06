const root = document.getElementById('root');
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLATFORM = { 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', desktop: 'Desktop audio' };
let current = null;

function render() {
  const d = current;
  root.innerHTML = `<div class="card">
    <div class="row"><img class="logo" src="logo.png" alt=""><div class="grow"><h1>Record this meeting?</h1><div class="sub">${esc(PLATFORM[d.platform] || 'Meeting')} · ${esc(d.title)}</div></div></div>
    ${d.needsConsent ? `<label class="consent"><input type="checkbox" id="consent"><span>I'll tell everyone in the meeting that it is being recorded.</span></label>` : ''}
    <div class="btns"><button data-a="ignore">Ignore</button><button class="primary" data-a="record" ${d.needsConsent ? 'disabled' : ''}>Record</button></div>
  </div>`;
  requestAnimationFrame(() => window.widget.prompt.resize(root.firstElementChild.offsetHeight));
}

root.addEventListener('change', (e) => { if (e.target.id === 'consent') root.querySelector('[data-a=record]').disabled = !e.target.checked; });
root.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b || !current) return;
  window.widget.prompt.answer({ windowId: current.windowId, answer: b.dataset.a, consent: !!document.getElementById('consent')?.checked });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) window.widget.prompt.answer({ windowId: current.windowId, answer: 'ignore' }); });
window.widget.prompt.onData((d) => { current = d; render(); });
