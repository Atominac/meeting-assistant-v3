import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { download, fmtTime, initials, speakerColor } from '../util.js';

function Highlight({ text, q }) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark><Highlight text={text.slice(i + q.length)} q={q} /></>;
}

export default function Transcript({ meetingId, title, segments, speakers, time, onSeek, onRename, toast }) {
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [who, setWho] = useState('');
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);
  const listRef = useRef(null), activeRef = useRef(null);

  const active = useMemo(() => {
    let lo = 0, hi = segments.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segments[mid].start <= time + 0.15) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }, [segments, time]);

  // Scroll only the transcript list. scrollIntoView would also move the page and every other scroller above it.
  useEffect(() => {
    const box = listRef.current, el = activeRef.current;
    if (!follow || q || !box || !el) return;
    const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) box.scrollTo({ top: box.scrollTop + (r.top - b.top) - b.height / 3, behavior: 'smooth' });
  }, [active, follow, q]);

  const all = segments.map((s, i) => ({ s, i }));
  const shown = all.filter(({ s }) => (!who || s.speaker === who) && (!q || s.text.toLowerCase().includes(q.toLowerCase()) || s.speaker.toLowerCase().includes(q.toLowerCase())));
  const names = speakers.map((x) => x.name);

  const exportAs = async (fmt) => {
    setMenu(false);
    const body = await api.text(`/meetings/${meetingId}/export?format=${fmt}`);
    download(`${title.replace(/[^\w ]+/g, '').trim() || 'meeting'}.${fmt}`, body);
  };
  const copy = async () => {
    setMenu(false);
    await navigator.clipboard.writeText(await api.text(`/meetings/${meetingId}/export?format=txt`));
    toast('Transcript copied');
  };

  return (
    <>
      <div className="tbar">
        <div className="spk">
          {['', ...speakers.filter((x) => x.sec > 0).map((x) => x.name)].slice(0, 7).map((n) => <button key={n || 'all'} className={who === n ? 'on' : ''} onClick={() => setWho(n)}>{n || 'All Speakers'}</button>)}
        </div>
        <div className="tools">
          <button className={`ibtn ${searching ? 'on' : ''}`} onClick={() => { setSearching(!searching); if (searching) setQ(''); }} aria-label="Search transcript" title="Search"><Icon name="search" size={18} /></button>
          <button className={`follow ${follow ? 'on' : ''}`} onClick={() => setFollow(!follow)} aria-pressed={follow} title="Scroll along with the video">Follow</button>
          <div style={{ position: 'relative' }}>
            <button className="ibtn" onClick={() => setMenu(!menu)} aria-label="Export" title="Export"><Icon name="download" size={18} /></button>
            {menu && <div className="pop" onMouseLeave={() => setMenu(false)}>
              <button onClick={copy}>Copy as text</button><button onClick={() => exportAs('txt')}>Download .txt</button>
              <button onClick={() => exportAs('vtt')}>Download .vtt (captions)</button><button onClick={() => exportAs('srt')}>Download .srt</button>
            </div>}
          </div>
        </div>
      </div>
      {searching && <div className="search tsearch"><Icon name="search" size={15} /><input className="input" autoFocus placeholder="Search transcript" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
      <div className="panel-body tlist" ref={listRef}>
        {!segments.length && <div className="empty">No transcript was captured for this meeting.</div>}
        {(q || who) && segments.length > 0 && <div className="muted small" style={{ padding: '0 0 8px 28px' }}>{shown.length} line{shown.length === 1 ? '' : 's'}</div>}
        {shown.map(({ s, i }) => (
          <button key={i} ref={i === active ? activeRef : null} className={`tline ${i === active ? 'now' : ''}`} onClick={() => onSeek(s.start)}>
            <span className="tdot" style={{ background: speakerColor(s.speaker, names) }} />
            <span className="thead">
              <span className="avatar" style={{ background: speakerColor(s.speaker, names) }}>{initials(s.speaker)}</span>
              <span className="tname" onClick={(e) => { e.stopPropagation(); const n = prompt(`Rename "${s.speaker}" to:`, s.speaker); if (n && n.trim() && n !== s.speaker) onRename(s.speaker, n.trim()); }} title="Click to rename this speaker">{s.speaker}</span>
              <time>{fmtTime(s.start)}</time>
            </span>
            <span className="ttext"><Highlight text={s.text} q={q} /></span>
          </button>
        ))}
      </div>
    </>
  );
}
