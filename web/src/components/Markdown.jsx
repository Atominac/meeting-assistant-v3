import { Fragment } from 'react';
import { fmtTime } from '../util.js';

// Small renderer for the subset of Markdown the assistant uses, plus [[meetingId@seconds]] citations.
const INLINE = /(\[\[[^\]@]+@\d+\]\])|(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*\n]+\*)/g;

function inline(text, onCite, titles) {
  const out = []; let last = 0, m, k = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('[[')) {
      const [id, sec] = t.slice(2, -2).split('@');
      const label = `${titles?.[id] ? titles[id] + ' · ' : ''}${fmtTime(+sec)}`;
      out.push(<button key={k++} className="cite" onClick={() => onCite?.(id, +sec)} title="Jump to this moment">▶ {label}</button>);
    } else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ text, onCite, titles }) {
  const clean = text.replace(/\[\[[^\]]*$/, ''); // hide a half-streamed citation
  const lines = clean.split('\n'), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const body = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      blocks.push({ t: 'code', v: body.join('\n') });
    } else if (/^\s*([-*•])\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
      i--; blocks.push({ t: 'ul', v: items });
    } else if (/^\s*\d+[.)]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      i--; blocks.push({ t: 'ol', v: items });
    } else if (/^#{1,4}\s/.test(l)) blocks.push({ t: 'h', v: l.replace(/^#+\s/, '') });
    else if (l.trim()) {
      const para = [l];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,4}\s|\s*([-*•]|\d+[.)])\s)/.test(lines[i + 1])) para.push(lines[++i]);
      blocks.push({ t: 'p', v: para.join(' ') });
    }
  }
  return blocks.map((b, i) => {
    if (b.t === 'code') return <pre key={i}><code>{b.v}</code></pre>;
    if (b.t === 'h') return <p key={i}><strong>{inline(b.v, onCite, titles)}</strong></p>;
    if (b.t === 'ul' || b.t === 'ol') {
      const L = b.t;
      return <L key={i}>{b.v.map((x, j) => <li key={j}>{inline(x, onCite, titles)}</li>)}</L>;
    }
    return <p key={i}>{inline(b.v, onCite, titles)}</p>;
  }).map((b, i) => <Fragment key={i}>{b}</Fragment>);
}
