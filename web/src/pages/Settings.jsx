import { useCallback, useEffect, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../App.jsx';
import { getTheme, setTheme } from '../theme.js';

const Status = ({ ok, label, hint }) => (
  <div className="setting"><div><b>{label}</b><div className="desc">{ok ? 'Connected' : hint}</div></div><span className={`pill ${ok ? 'ok' : 'warn'}`}>{ok ? 'On' : 'Not set up'}</span></div>
);
const ago = (d) => { const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : new Date(d).toLocaleDateString(); };

export default function Settings() {
  const { user, config, setUser, logout } = useAuth();
  const tpl = user.prefs?.summaryTemplate || 'general';
  const setTpl = async (v) => { setUser({ ...user, prefs: { ...user.prefs, summaryTemplate: v } }); try { await api.patch('/auth/prefs', { summaryTemplate: v }); toast('Default notes template saved'); } catch (e) { setUser(user); toast(e.message); } };
  const toast = useToast();
  const [theme, setThemeState] = useState(getTheme);
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwErr, setPwErr] = useState('');
  const [sessions, setSessions] = useState([]);

  const load = useCallback(() => {
    api.get('/auth/sessions').then((r) => setSessions(r.items)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveName = async () => { if (name.trim() && name.trim() !== user.name) { await api.patch('/auth/me', { name }); setUser({ ...user, name: name.trim() }); toast('Name updated'); } };
  const changePw = async (e) => {
    e.preventDefault(); setPwErr('');
    try { await api.post('/auth/password', pw); setPw({ current: '', next: '' }); toast('Password changed. Other devices were signed out.'); load(); } catch (err) { setPwErr(err.message); }
  };
  const revoke = async (s) => { if (confirm(`Sign out “${s.label || s.kind}”?`)) { await api.del(`/auth/sessions/${s._id}`); load(); } };
  const ask = user.prefs?.askToRecord !== false;
  const setAsk = async (v) => {
    setUser({ ...user, prefs: { ...user.prefs, askToRecord: v } }); // optimistic
    try { await api.patch('/auth/prefs', { askToRecord: v }); toast(v ? 'You will be asked when a meeting starts' : 'Meeting prompts are off'); }
    catch (e) { setUser(user); toast(e.message); }
  };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head"><div><h1>Settings</h1><div className="sub">{user.email}</div></div></div>

      <div className="day">Account</div>
      <div className="group">
        <div className="setting"><div style={{ flex: 1 }}><b>Name</b></div><input className="input" style={{ maxWidth: 260 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} aria-label="Name" /></div>
        <form className="setting" style={{ flexDirection: 'column', alignItems: 'stretch' }} onSubmit={changePw}>
          <div><b>Change password</b><div className="desc">Signs out all your other devices.</div></div>
          <div className="toolbar">
            <input className="input" style={{ flex: 1, minWidth: 160 }} type="password" autoComplete="current-password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            <input className="input" style={{ flex: 1, minWidth: 160 }} type="password" autoComplete="new-password" placeholder="New password (8+ characters)" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
            <button className="btn">Update</button>
          </div>
          {pwErr && <div className="auth-error" style={{ margin: 0 }}>{pwErr}</div>}
        </form>
        <div className="setting"><div><b>Sign out</b><div className="desc">On this browser.</div></div><button className="btn sm" onClick={logout}>Sign out</button></div>
      </div>

      <div className="day">Desktop app</div>
      <div className="group">
        <div className="setting"><div><b>Record from your Mac</b><div className="desc">Open the Meeting Assistant desktop app and log in with <b>{user.email}</b>. Its floating widget announces Zoom and Google Meet calls and records them without a bot.</div></div></div>
        {sessions.map((s) => (
          <div className="setting" key={s._id}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
              <Icon name={s.kind === 'desktop' ? 'desktop' : 'user'} size={22} style={{ color: 'var(--accent)', flex: 'none' }} />
              <div style={{ minWidth: 0 }}><b>{s.label || (s.kind === 'desktop' ? 'Desktop app' : 'Browser')}</b>{s.current && <span className="pill ok" style={{ marginLeft: 8 }}>This device</span>}<div className="desc">{s.kind === 'desktop' ? 'Desktop app' : 'Web'} · active {ago(s.lastSeenAt)}</div></div>
            </div>
            {!s.current && <button className="btn sm danger" onClick={() => revoke(s)}>Sign out</button>}
          </div>
        ))}
      </div>

      <div className="day">Recording</div>
      <div className="group">
        <div className="setting">
          <div><b>Ask me when a meeting starts</b><div className="desc">When the desktop app detects a Zoom or Google Meet call, a pop-up asks “Record this meeting?” You choose Record or Ignore. Recording stops by itself when the meeting ends. If this is off, nothing is recorded unless you press Record on the tab.</div></div>
          <button role="switch" aria-checked={ask} aria-label="Ask me when a meeting starts" className={`switch ${ask ? 'on' : ''}`} onClick={() => setAsk(!ask)}><span /></button>
        </div>
      </div>

      <div className="day">Notes</div>
      <div className="group">
        <div className="setting">
          <div><b>Default notes template</b><div className="desc">Used when notes are written for a new recording. You can pick a different one for any meeting when you regenerate its notes.</div></div>
          <select className="tplsel" aria-label="Default notes template" value={tpl} onChange={(e) => setTpl(e.target.value)}>{(config.templates || []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        </div>
      </div>

      <div className="day">Appearance</div>
      <div className="group">
        <div className="setting"><div><b>Theme</b><div className="desc">System follows your device.</div></div>
          <div className="seg">{[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => <button key={k} className={theme === k ? 'on' : ''} onClick={() => { setTheme(k); setThemeState(k); }}>{l}</button>)}</div>
        </div>
      </div>

      <div className="day">Server</div>
      <div className="group">
        <Status ok={config.recording} label="Meeting recording" hint="Not set up on the server yet. Ask your admin." />
        <Status ok={!!config.transcription} label="Transcription" hint="Not set up on the server yet. Ask your admin." />
        <Status ok={config.ai} label="AI notes and chat" hint="Not set up on the server yet. Ask your admin." />
      </div>
    </div>
  );
}
