import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAuthLostHandler, setToken } from './api.js';
import AuthScreen from './pages/AuthScreen.jsx';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

// Inside GoHighLevel's iframe storage can be blocked or partitioned, so fall back to memory.
let memory = null;
const store = {
  get() { try { return localStorage.getItem('ma.token') || memory; } catch { return memory; } },
  set(t) { memory = t; try { t ? localStorage.setItem('ma.token', t) : localStorage.removeItem('ma.token'); } catch { /* memory only */ } },
};

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', config: null, user: null });

  const signedOut = useCallback(() => { store.set(null); setToken(null); setState((s) => ({ ...s, status: 'anon', user: null })); }, []);
  useEffect(() => { setAuthLostHandler(signedOut); }, [signedOut]);

  useEffect(() => {
    (async () => {
      let config;
      try { config = await api.get('/config'); } catch (e) { return setState({ status: 'error', error: e.message }); }
      const t = store.get();
      if (!t) return setState({ status: 'anon', config, user: null });
      setToken(t);
      try { const me = await api.get('/auth/me'); setState({ status: 'ready', config, user: me.user }); }
      catch { store.set(null); setToken(null); setState({ status: 'anon', config, user: null }); }
    })();
  }, []);

  const value = useMemo(() => ({
    ...state,
    async login(email, password) { const r = await api.post('/auth/login', { email, password, deviceName: browserName() }); store.set(r.token); setToken(r.token); setState((s) => ({ ...s, status: 'ready', user: r.user })); },
    async signup(fields) { const r = await api.post('/auth/signup', { ...fields, deviceName: browserName() }); store.set(r.token); setToken(r.token); setState((s) => ({ ...s, status: 'ready', user: r.user })); },
    async logout() { try { await api.post('/auth/logout'); } catch { /* already gone */ } signedOut(); },
    setUser: (user) => setState((s) => ({ ...s, user })),
  }), [state, signedOut]);

  if (state.status === 'loading') return <div className="splash"><div className="spinner" /></div>;
  if (state.status === 'error') return <div className="splash"><div className="empty"><h2>Can't reach the server</h2><p>{state.error}</p></div></div>;
  if (state.status === 'anon') return <Ctx.Provider value={value}><AuthScreen /></Ctx.Provider>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  const os = /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ` on ${os}` : ''}${window.self !== window.top ? ' (in GoHighLevel)' : ''}`;
}
