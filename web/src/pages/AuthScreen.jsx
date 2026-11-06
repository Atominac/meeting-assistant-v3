import { useState } from 'react';
import { useAuth } from '../auth.jsx';

export default function AuthScreen() {
  const { login, signup, config } = useAuth();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '', inviteCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const up = mode === 'signup';
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try { up ? await signup(f) : await login(f.email, f.password); }
    catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card card" onSubmit={submit}>
        <img className="auth-logo" src="/logo.png" alt="Meetings" />
        <h1>{up ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted" style={{ margin: '4px 0 18px', textAlign: 'center' }}>{up ? 'Record meetings, get transcripts and notes.' : 'Log in to your meetings.'}</p>

        {up && <label>Name<input className="input" autoComplete="name" autoFocus value={f.name} onChange={set('name')} required /></label>}
        <label>Email<input className="input" type="email" autoComplete="email" autoFocus={!up} value={f.email} onChange={set('email')} required /></label>
        <label>Password<input className="input" type="password" autoComplete={up ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} required minLength={up ? 8 : undefined} />
          {up && <span className="muted small">At least 8 characters.</span>}</label>
        {up && config?.inviteRequired && <label>Invite code<input className="input" autoComplete="off" value={f.inviteCode} onChange={set('inviteCode')} required /></label>}

        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="btn primary" style={{ width: '100%', padding: '9px 14px', marginTop: 6 }} disabled={busy}>{busy ? 'Please wait…' : up ? 'Sign up' : 'Log in'}</button>
        <p className="muted" style={{ textAlign: 'center', margin: '16px 0 0' }}>
          {up ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" className="btn plain" onClick={() => { setMode(up ? 'login' : 'signup'); setError(''); }}>{up ? 'Log in' : 'Create an account'}</button>
        </p>
      </form>
    </div>
  );
}
