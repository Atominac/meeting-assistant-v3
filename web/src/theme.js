// "system" follows the OS; "light" and "dark" are explicit and remembered in this browser.
const KEY = 'ma.theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
export const getTheme = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
export const effective = (t = getTheme()) => (t === 'system' ? (mq?.matches ? 'dark' : 'light') : t);
export function setTheme(t) {
  try { t === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t); } catch { /* private mode: applies for this page only */ }
  const r = document.documentElement;
  t === 'system' ? r.removeAttribute('data-theme') : r.setAttribute('data-theme', t);
  window.dispatchEvent(new Event('ma-theme'));
}
setTheme(getTheme());
