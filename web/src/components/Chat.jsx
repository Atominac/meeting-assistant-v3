import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import Markdown from './Markdown.jsx';
import { streamChat } from '../api.js';

const Speech = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

// `home` switches to the full-page Ask AI look: a greeting and a pill input in the middle until the first question.
export default function Chat({ meetingId, suggestions = [], onCite, titles, placeholder = 'Ask about this meeting', home = false, name = '', onMessages }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tips, setTips] = useState(false);
  const [listening, setListening] = useState(false);
  const end = useRef(null), abort = useRef(null), ta = useRef(null), rec = useRef(null);

  useEffect(() => { const box = end.current?.parentElement; if (box) box.scrollTop = box.scrollHeight; }, [msgs]); // scroll the message list only, never the page
  useEffect(() => () => { abort.current?.abort(); rec.current?.stop(); }, []);
  useEffect(() => { setMsgs([]); setError(''); }, [meetingId]);
  useEffect(() => { onMessages?.(msgs); }, [msgs]); // eslint-disable-line

  async function ask(text) {
    text = text.trim();
    if (!text || busy) return;
    const history = [...msgs, { role: 'user', content: text }];
    setMsgs([...history, { role: 'assistant', content: '' }]);
    setInput(''); setBusy(true); setError(''); setTips(false);
    if (ta.current) ta.current.style.height = 'auto';
    abort.current = new AbortController();
    try {
      await streamChat({
        meetingId, messages: history, signal: abort.current.signal,
        onText: (t) => setMsgs((m) => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: c.at(-1).content + t }; return c; }),
      });
    } catch (e) {
      setError(e.message);
      setMsgs((m) => (m.at(-1)?.content ? m : m.slice(0, -1)));
    } finally { setBusy(false); }
  }

  function dictate() {
    if (rec.current) { rec.current.stop(); return; }
    const r = new Speech(), base = input ? input.trimEnd() + ' ' : '';
    r.interimResults = true;
    r.onresult = (e) => setInput(base + Array.from(e.results).map((x) => x[0].transcript).join(''));
    r.onend = () => { rec.current = null; setListening(false); };
    r.onerror = () => { rec.current = null; setListening(false); };
    rec.current = r; setListening(true); r.start();
  }

  const grow = (e) => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; };
  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } };
  const empty = !msgs.length;

  const messages = (
    <div className="msgs">
      {empty && !home && (
        <div className="empty" style={{ padding: '28px 12px' }}>
          <h2>Ask anything</h2>
          <p>Answers come only from your recorded meetings and link to the exact moment.</p>
        </div>
      )}
      {msgs.map((m, i) => (
        <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
          {m.role === 'user' ? m.content : (
            <div className={busy && i === msgs.length - 1 ? 'typing' : ''}>{m.content ? <Markdown text={m.content} onCite={onCite} titles={titles} /> : <span className="muted">Thinking…</span>}</div>
          )}
        </div>
      ))}
      {error && <div className="msg ai" style={{ color: 'var(--red)' }}>{error}</div>}
      <div ref={end} />
    </div>
  );

  if (home) {
    const pill = (
      <form className="pill-input" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <button type="button" className="plus" aria-label="Suggestions" aria-expanded={tips} onClick={() => setTips(!tips)}><Icon name="plus" size={22} strokeWidth={1.8} /></button>
        <textarea ref={ta} rows={1} value={input} placeholder={placeholder} onChange={grow} onKeyDown={onKey} autoFocus />
        {Speech && <button type="button" className={`mic ${listening ? 'on' : ''}`} aria-label={listening ? 'Stop dictation' : 'Dictate'} onClick={dictate}><Icon name="mic" size={20} /></button>}
        {input.trim()
          ? <button className="go" disabled={busy} aria-label="Send" type="submit"><Icon name="send" size={18} strokeWidth={2.4} /></button>
          : <button className="go" type="button" disabled={!Speech} aria-label="Voice" onClick={dictate}><Icon name="wave" size={20} strokeWidth={2.4} /></button>}
      </form>
    );
    const chips = tips && suggestions.length > 0 && <div className="tips">{suggestions.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>;
    return empty ? (
      <div className="chat home hero">
        <div className="hero-box">
          <h1>What's on your mind{name ? `, ${name}` : ''}?</h1>
          {pill}{chips}
          {error && <div className="muted" style={{ color: 'var(--red)', marginTop: 12 }}>{error}</div>}
        </div>
      </div>
    ) : (
      <div className="chat home">
        {messages}
        <div className="dock">{chips}{pill}</div>
      </div>
    );
  }

  return (
    <div className="chat">
      {messages}
      {empty && suggestions.length > 0 && <div className="suggest">{suggestions.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <textarea ref={ta} rows={1} value={input} placeholder={placeholder} onChange={grow} onKeyDown={onKey} />
        {msgs.length > 0 && !busy && <button type="button" className="btn sm plain" onClick={() => setMsgs([])}>Clear</button>}
        <button className="send" disabled={!input.trim() || busy} aria-label="Send"><Icon name="send" size={16} strokeWidth={2.4} /></button>
      </form>
    </div>
  );
}
