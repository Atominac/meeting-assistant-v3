import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { api } from '../api.js';
import { clock, dayLabel, fmtDuration, initials, platformOf, speakerColor } from '../util.js';

export const StatusPill = ({ m }) => {
  if (m.status === 'recording') return <span className="pill live">Recording</span>;
  if (m.status === 'processing') return <span className="pill warn">Processing…</span>;
  if (m.status === 'failed') return <span className="pill warn">Failed</span>;
  return null;
};

export default function Meetings() {
  const nav = useNavigate();
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');

  const load = (query = q) => api.get(`/meetings?q=${encodeURIComponent(query)}`).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { const t = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (!items?.some((m) => m.status === 'recording' || m.status === 'processing')) return;
    const t = setInterval(() => load(), 8000); return () => clearInterval(t);
  }, [items, q]);

  const [plat, setPlat] = useState('all');
  const [sort, setSort] = useState('new');
  const [open, setOpen] = useState('');
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q, plat, sort, size]);

  const rows = useMemo(() => {
    const r = (items || []).filter((m) => plat === 'all' || m.platform === plat || (plat === 'google-meet' && m.platform === 'meet'));
    const by = { new: (a, b) => new Date(b.startedAt) - new Date(a.startedAt), old: (a, b) => new Date(a.startedAt) - new Date(b.startedAt), long: (a, b) => (b.durationSec || 0) - (a.durationSec || 0) }[sort];
    return r.sort(by);
  }, [items, plat, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const shown = rows.slice((page - 1) * size, page * size);
  const stamp = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const SORTS = { new: 'Newest first', old: 'Oldest first', long: 'Longest first' };
  const PLATS = [['all', 'All platforms'], ['zoom', 'Zoom'], ['google-meet', 'Google Meet'], ['teams', 'Microsoft Teams']];

  return (
    <div className="page">
      <div className="gcard">
        <div className="gtools">
          <div className="gtools-l">
            <div className="rel">
              <button className={`tool ${plat !== 'all' ? 'on' : ''}`} onClick={() => setOpen(open === 'f' ? '' : 'f')}><Icon name="filter" size={16} />Filters</button>
              {open === 'f' && <div className="pop left" onMouseLeave={() => setOpen('')}>{PLATS.map(([k, l]) => <button key={k} onClick={() => { setPlat(k); setOpen(''); }}>{plat === k ? '✓ ' : ''}{l}</button>)}</div>}
            </div>
            <span className="vsep" />
            <div className="rel">
              <button className="tool" onClick={() => setOpen(open === 's' ? '' : 's')}><Icon name="sort" size={16} />Sort</button>
              {open === 's' && <div className="pop left" onMouseLeave={() => setOpen('')}>{Object.entries(SORTS).map(([k, l]) => <button key={k} onClick={() => { setSort(k); setOpen(''); }}>{sort === k ? '✓ ' : ''}{l}</button>)}</div>}
            </div>
            <span className="vsep" />
            <span className="count-chip">{rows.length} {rows.length === 1 ? 'Meeting' : 'Meetings'}</span>
          </div>
          <div className="search gsearch"><Icon name="search" size={16} /><input className="input" placeholder="Search meetings and transcripts" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>

        <div className="gtable-wrap">
          <table className="gtable">
            <thead><tr><th>Meeting</th><th>Platform</th><th>Date</th><th>Duration</th><th>People</th><th>Topics</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((m) => {
                const p = platformOf(m.platform), names = (m.speakers || []).map((s) => s.name);
                return (
                  <tr key={m._id} onClick={() => nav(`/meeting/${m._id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/meeting/${m._id}`)}>
                    <td><div className="cellname"><span className="mini" style={{ background: p.color }}><Icon name="video" size={13} /></span><span className="cut">{m.title}</span></div></td>
                    <td><span className="dot" style={{ background: p.color }} /> {p.label}</td>
                    <td className="nowrap">{stamp(m.startedAt)}</td>
                    <td>{m.durationSec ? fmtDuration(m.durationSec) : ''}</td>
                    <td>{names.length > 0 && <div className="stack">{names.slice(0, 4).map((n) => <span key={n} className="avatar" style={{ background: speakerColor(n, names) }} title={n}>{initials(n)}</span>)}</div>}</td>
                    <td><div className="chips">{(m.summary?.topics || []).slice(0, 2).map((t) => <span key={t} className="chip">{t}</span>)}</div></td>
                    <td>{m.status === 'ready' ? <span className="pill ok">Ready</span> : <StatusPill m={m} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items === null && <div className="splash" style={{ height: 200 }}><div className="spinner" /></div>}
          {items && rows.length === 0 && (
            <div className="empty">
              <h2>{q || plat !== 'all' ? 'No matches' : 'No recordings yet'}</h2>
              <p>{q || plat !== 'all' ? 'Try a different word or filter.' : 'Install the desktop app and log in with this account, then join a Zoom or Google Meet call. A pop-up will offer to record it.'}</p>
              {!q && plat === 'all' && <button className="btn primary" onClick={() => nav('/settings')}>See how it works</button>}
            </div>
          )}
        </div>

        <div className="gfoot">
          <span>Page {page} of {pages}</span>
          <div className="pager">
            <select className="pg" value={size} onChange={(e) => setSize(+e.target.value)} aria-label="Rows per page">{[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <button className="pg" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button className="pg cur">{page}</button>
            <button className="pg" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
