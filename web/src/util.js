export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
export const fmtDuration = (s) => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${Math.max(1, m)} min`;
};
export const clock = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
export function dayLabel(d) {
  const x = new Date(d), now = new Date();
  if (sameDay(x, now)) return 'Today';
  if (sameDay(x, new Date(+now - 864e5))) return 'Yesterday';
  if (sameDay(x, new Date(+now + 864e5))) return 'Tomorrow';
  return x.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(x.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export const PLATFORM = {
  'google-meet': { label: 'Google Meet', color: 'var(--green)' }, meet: { label: 'Google Meet', color: 'var(--green)' },
  zoom: { label: 'Zoom', color: 'var(--blue)' }, teams: { label: 'Teams', color: 'var(--purple)' },
};
export const platformOf = (p) => PLATFORM[p] || { label: p && p !== 'unknown' ? p : 'Meeting', color: 'var(--gray)' };
const PALETTE = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#FFCC00', '#30B0C7'];
export const speakerColor = (name, all = []) => PALETTE[Math.max(0, all.indexOf(name)) % PALETTE.length];
export const initials = (n = '?') => n.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
export function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
