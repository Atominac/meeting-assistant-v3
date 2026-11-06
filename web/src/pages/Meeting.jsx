import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Chat from '../components/Chat.jsx';
import Icon from '../components/Icon.jsx';
import Player from '../components/Player.jsx';
import Transcript from '../components/Transcript.jsx';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useToast } from '../App.jsx';
import { clock, fmtDuration, fmtTime, initials, platformOf, speakerColor } from '../util.js';

const SUGGEST = ['Summarize this in 3 bullets', 'What decisions were made?', 'What are my action items?', 'Show a timeline of the topics as an ASCII chart'];

export default function Meeting() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { config, user } = useAuth();
  const [tpl, setTpl] = useState('');
  const [m, setM] = useState(null);
  const [tab, setTab] = useState('transcript');
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState({});
  const [menu, setMenu] = useState(false);
  const [pip, setPip] = useState(false);
  const [ask, setAsk] = useState(false);
  const player = useRef(null);

  const load = useCallback(() => api.get(`/meetings/${id}`).then(setM).catch((e) => setM({ error: e.message })), [id]);
  useEffect(() => { setM(null); load(); }, [load]);
  useEffect(() => {
    if (!m || m.error) return;
    const inProgress = m.status === 'recording' || m.status === 'processing';
    const notesComing = m.status === 'ready' && config.ai && m.segments?.length > 0 && !m.summary; // summary is written right after the transcript lands
    if (!inProgress && !notesComing) return;
    const t = setInterval(load, 6000); return () => clearInterval(t);
  }, [m, load]);
  useEffect(() => {
    const t = Number(sp.get('t'));
    if (m?.mediaUrl && t) setTimeout(() => player.current?.seek(t, false), 300);
  }, [m?.mediaUrl]); // eslint-disable-line

  if (!m) return <div className="splash"><div className="spinner" /></div>;
  if (m.error) return <div className="page"><div className="empty"><h2>Meeting not found</h2><p>{m.error}</p><button className="btn" onClick={() => nav('/')}>Back to recordings</button></div></div>;

  const segs = m.segments || [], names = (m.speakers || []).map((s) => s.name), p = platformOf(m.platform), S = m.summary;
  const seek = (t) => { player.current?.seek(t); if (!m.mediaUrl) toast(`No video, ${fmtTime(t)}`); };
  const cite = (_id, t) => seek(t);
  const rename = async (from, to) => { await api.patch(`/meetings/${id}`, { rename: { from, to } }); load(); };
  const saveTitle = async (v) => { v = v.trim(); if (v && v !== m.title) { await api.patch(`/meetings/${id}`, { title: v }); setM({ ...m, title: v }); } };
  const summarize = async () => {
    setBusy(true);
    try { await api.post(`/meetings/${id}/summarize`, { template: tpl || m.summary?.template || user.prefs?.summaryTemplate || 'general' }); setTpl(''); await load(); toast('Notes updated'); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const tplPick = (
    <select className="tplsel" aria-label="Notes template" value={tpl || m.summary?.template || user.prefs?.summaryTemplate || 'general'} onChange={(e) => setTpl(e.target.value)}>
      {(config.templates || []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
    </select>
  );
  const reprocess = async () => {
    if (!confirm('Process this recording again? The transcript, speaker names and notes are created again from the video, and any edits to them are replaced.')) return;
    setMenu(false);
    try { await api.post(`/meetings/${id}/reprocess`); toast('Processing again'); await load(); } catch (e) { toast(e.message); }
  };
  const remove = async () => { if (confirm('Delete this recording, transcript and video?')) { await api.del(`/meetings/${id}`); nav('/'); } };
  const pending = m.status === 'recording' || m.status === 'processing';

  const people = m.speakers || [];
  const tabs = [['transcript', 'Transcript']];

  return (
    <div className="page fit">
      <div className="crumbs"><button onClick={() => nav('/')}>Recordings</button><span>/</span><b>{m.title}</b></div>

      {m.status === 'failed' && <div className="card" style={{ padding: 16, marginBottom: 12, color: 'var(--red)' }}>This recording failed: {m.error || 'unknown error'} <button className="btn" style={{ marginLeft: 8 }} onClick={reprocess}>Try again</button></div>}
      {pending && (
        <div className="card" style={{ padding: 16, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <div className="spinner" />
          <div><b>{m.status === 'recording' ? 'This meeting is being recorded' : 'Processing your recording'}</b><div className="muted small">{m.status === 'recording' ? 'It appears here when the call ends.' : 'The upload is finishing, then the transcript and notes are created. Usually a few minutes.'}{m.lastError ? ` (${m.lastError})` : ''}</div></div>
        </div>
      )}

      <div className="mcard">
        <div className="mtitle">
          <span className="bigdot" style={{ background: p.color }} />
          <input className="title-input" defaultValue={m.title} key={m.title} onBlur={(e) => saveTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} aria-label="Meeting title" />
          {m.status === 'recording' && <span className="pill live">Recording</span>}
          {m.status === 'processing' && <span className="pill warn">Processing</span>}
          {people.length > 0 && <div className="stack">{people.slice(0, 4).map((x) => <span key={x.name} className="avatar" style={{ background: speakerColor(x.name, names) }} title={x.name}>{initials(x.name)}</span>)}{people.length > 4 && <span className="avatar more">+{people.length - 4}</span>}</div>}
          <div style={{ position: 'relative' }}>
            <button className="btn icon" onClick={() => setMenu(!menu)} aria-label="More">⋯</button>
            {menu && <div className="pop" onMouseLeave={() => setMenu(false)}>
              {m.url && <button onClick={() => window.open(m.url, '_blank')}>Open meeting link</button>}
              <button onClick={summarize}>Regenerate notes</button>
              {!pending && <button onClick={reprocess}>Process recording again</button>}
              <button onClick={remove} style={{ color: 'var(--red)' }}>Delete…</button>
            </div>}
          </div>
          <button className={`btn askbtn ${ask ? 'on' : ''}`} onClick={() => setAsk(!ask)} aria-pressed={ask}><Icon name="sparkles" size={16} />Ask AI</button>
        </div>

        <div className={`mgrid ${ask ? 'with-ask' : ''}`}>
          <aside className="mleft">
            <dl className="props">
              <dt><Icon name="video" size={16} />Platform</dt><dd><span className="tagpill"><span className="dot" style={{ background: p.color }} />{p.label}</span></dd>
              <dt><Icon name="calendar" size={16} />Recorded</dt><dd>{new Date(m.startedAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })} at {clock(m.startedAt)}</dd>
              {m.userName && <><dt><Icon name="user" size={16} />Recorded by</dt><dd>{m.userName}</dd></>}
              {S?.topics?.length > 0 && <><dt><Icon name="tag" size={16} />Topics</dt><dd className="wrap">{S.topics.map((t) => <span key={t} className="chip">{t}</span>)}</dd></>}
              {people.length > 0 && <><dt><Icon name="team" size={16} />Participants</dt><dd className="wrap">{people.slice(0, 4).map((x) => <span key={x.name} className="tagpill"><span className="avatar" style={{ background: speakerColor(x.name, names) }}>{initials(x.name)}</span>{x.name}</span>)}{people.length > 4 && <span className="muted">+{people.length - 4}</span>}</dd></>}
            </dl>

            <section className="msec summary"><h3>Summary</h3>
                  {!S && (
                    <div className="empty" style={{ padding: 24 }}>
                      <h2>{segs.length ? 'No notes yet' : 'Waiting for the transcript'}</h2>
                      {segs.length > 0 && <><p>Generate an overview, decisions and action items.</p>{tplPick}<button className="btn primary" disabled={busy} onClick={summarize}>{busy ? 'Writing…' : 'Generate notes'}</button></>}
                    </div>
                  )}
                  {S && (
                    <>
                      <div className="section"><h3>Overview</h3><p style={{ margin: 0 }}>{S.overview}</p></div>
                      {S.actionItems?.length > 0 && <div className="section"><h3>Action items</h3>{S.actionItems.map((a, i) => (
                        <div className="todo" key={i}>
                          <button className={`check ${done[i] ? 'on' : ''}`} onClick={() => setDone({ ...done, [i]: !done[i] })} aria-label="Mark done">{done[i] && <Icon name="check" size={12} strokeWidth={3} />}</button>
                          <div style={{ opacity: done[i] ? 0.5 : 1, textDecoration: done[i] ? 'line-through' : 'none' }}>{a.task}<div className="muted small">{[a.owner, a.due].filter(Boolean).join(' · ')}</div></div>
                        </div>))}</div>}
                      {S.decisions?.length > 0 && <div className="section"><h3>Decisions</h3><ul>{S.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></div>}
                      {S.keyPoints?.length > 0 && <div className="section"><h3>Key points</h3><ul>{S.keyPoints.map((d, i) => <li key={i}>{d}</li>)}</ul></div>}
                      <div className="tplrow">{tplPick}<button className="btn sm" disabled={busy} onClick={summarize}><Icon name="refresh" size={14} /> {busy ? 'Writing…' : 'Regenerate'}</button></div>
                    </>
                  )}
                </section>

            {people.length > 0 && (
              <section className="msec"><h3>Speaker Activity</h3>
                <div className="statbox">
                  {people.map((x) => (
                    <div className="act" key={x.name}>
                      <span className="who"><span className="avatar" style={{ background: speakerColor(x.name, names) }}>{initials(x.name)}</span><span className="cut2">{x.name}</span></span>
                      <span className="track"><span className="fill" style={{ width: `${x.pct}%`, background: speakerColor(x.name, names) }} /></span>
                      <b>{x.pct}%</b>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </aside>

          <div className={`mright ${pip ? 'pip' : ''}`}>
            {pip && <div className="pipnote"><Icon name="pip" size={16} />Video is playing in picture-in-picture<button className="btn sm" onClick={() => document.exitPictureInPicture?.().catch(() => {})}>Bring back</button></div>}
            <Player ref={player} onPip={setPip} src={m.mediaUrl} segments={segs} chapters={S?.chapters || []} duration={m.durationSec} speakers={names} onTime={setTime} />

            <div className="rpanel">
              <div className="utabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

              {tab === 'transcript' && <Transcript meetingId={id} title={m.title} segments={segs} speakers={people} time={time} onSeek={seek} onRename={rename} toast={toast} />}
            </div>
          </div>

          <aside className="asksheet" hidden={!ask} aria-label="Ask AI">
            <div className="asksheet-head"><b><Icon name="sparkles" size={16} />Ask AI</b><button className="ibtn" onClick={() => setAsk(false)} aria-label="Close">✕</button></div>
            <div className="asksheet-body"><Chat meetingId={id} suggestions={SUGGEST} onCite={cite} placeholder="Ask about this meeting" /></div>
          </aside>
        </div>
      </div>
    </div>
  );
}
