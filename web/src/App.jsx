import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Icon from './components/Icon.jsx';
import { initials } from './util.js';
import { effective, setTheme } from './theme.js';
import Meetings from './pages/Meetings.jsx';
import Meeting from './pages/Meeting.jsx';
import Ask from './pages/Ask.jsx';
import Settings from './pages/Settings.jsx';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

const TABS = [['/', 'video', 'Recordings', true], ['/ask', 'sparkles', 'Ask AI'], ['/settings', 'gear', 'Settings']];

// No sidebar here: the app is embedded in GoHighLevel, which supplies its own menu.
export default function App() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [toast, setToast] = useState('');
  const [menu, setMenu] = useState(false);
  const [dark, setDark] = useState(() => effective() === 'dark');
  useEffect(() => { const f = () => setDark(effective() === 'dark'); window.addEventListener('ma-theme', f); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', f); return () => { window.removeEventListener('ma-theme', f); matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', f); }; }, []);
  const show = useCallback((m) => setToast(m), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2200); return () => clearTimeout(t); }, [toast]);
  useEffect(() => setMenu(false), [pathname]);

  return (
    <ToastCtx.Provider value={show}>
      <div className="ghl">
        <header className="ghl-top">
          <div className="ghl-left">
            <h1 className="ghl-title">Meeting Assistant</h1>
            <nav className="tabs" aria-label="Sections">
              {TABS.map(([to, , label, end]) => (
                <NavLink key={to} to={to} end={end} className={({ isActive }) => `tab ${isActive || (to === '/' && pathname.startsWith('/meeting/')) ? 'on' : ''}`}>{label}</NavLink>
              ))}
            </nav>
          </div>
          <div className="ghl-top-r">
            <button className="theme-btn" onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}><Icon name={dark ? 'sun' : 'moon'} size={18} /></button>
          <div style={{ position: 'relative' }}>
            <button className="me-btn" onClick={() => setMenu(!menu)} aria-label="Account" aria-expanded={menu}>{initials(user.name)}</button>
            {menu && (
              <div className="pop acct" onMouseLeave={() => setMenu(false)}>
                <div className="who"><b>{user.name}</b><span>{user.email}</span></div>
                <NavLink to="/settings">Settings</NavLink>
                <button onClick={logout}>Sign out</button>
              </div>
            )}
          </div>
          </div>
        </header>
        <main className="ghl-main">
          <Routes>
            <Route path="/" element={<Meetings />} />
            <Route path="/meeting/:id" element={<Meeting />} />
            <Route path="/ask" element={<Ask />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </ToastCtx.Provider>
  );
}
