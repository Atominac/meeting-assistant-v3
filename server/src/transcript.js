// Word-level transcript JSON from a recording service: [{ participant: { id, name }, words: [{ text, start_timestamp: { relative }, end_timestamp }] }]
// -> flat segments [{ speaker, start, end, text }] plus per-speaker talk time.
export function normalizeTranscript(raw) {
  const segments = [];
  for (const block of Array.isArray(raw) ? raw : []) {
    const words = block.words || [];
    if (!words.length) continue;
    const speaker = block.participant?.name || `Speaker ${block.participant?.id ?? '?'}`;
    const start = words[0].start_timestamp?.relative ?? 0;
    const end = words.at(-1).end_timestamp?.relative ?? words.at(-1).start_timestamp?.relative ?? start;
    const text = words.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    const prev = segments.at(-1);
    if (prev && prev.speaker === speaker && start - prev.end < 1.5) { prev.end = end; prev.text += ` ${text}`; }
    else segments.push({ speaker, start, end, text });
  }
  return segments;
}

// Who was speaking when, from the SDK's participant events ({ event, name, relative }).
// Returns { name: [[from, to], ...] } in seconds. A speaker who never stops (or leaves) is closed at `end`.
export function speechIntervals(events, end = Infinity) {
  const open = new Map(), out = {};
  const close = (name, at) => {
    const from = open.get(name);
    if (from === undefined) return;
    open.delete(name);
    (out[name] ||= []).push([from, Math.max(from, at)]);
  };
  for (const e of [...events].sort((a, b) => a.relative - b.relative)) {
    if (!e.name) continue;
    if (e.event === 'participant_events.speech_on') { if (!open.has(e.name)) open.set(e.name, e.relative); }
    else if (e.event === 'participant_events.speech_off' || e.event === 'participant_events.leave') close(e.name, e.relative);
  }
  for (const name of [...open.keys()]) close(name, end);
  return out;
}

// Gives each transcript segment ({ start, end, text, fallback, channel }) a speaker name. In order of trust:
//  0. when the recording was transcribed with the microphone on its own channel, anything on that channel is the local
//     user (`me`), whatever the screen says;
//  1. the participant marked as speaking for most of the segment's time (speech markers from the screen);
//  2. the participant the transcriber's own label ("Speaker 2") overlaps most across the whole call, so one voice
//     keeps one name even where a marker was missed. Only used when the transcriber told at least two voices apart:
//     a single label says nothing about who is who;
//  3. the only other person in the call, since nobody else can be speaking;
//  4. the transcriber's label, or "Speaker".
// Speech markers come from reading the screen, so they can lag by a second or two: each interval is widened a little.
// Neighbouring segments of the same speaker are merged.
export function assignSpeakers(segments, intervals, { slack = 1, mergeGap = 1.5, people = [], me = null, selfChannel = 1, minShare = 0.3 } = {}) {
  const stereo = !!me && segments.some((s) => Number.isInteger(s.channel));
  const isMine = (seg) => stereo && seg.channel === selfChannel;
  const others = stereo ? Object.fromEntries(Object.entries(intervals).filter(([name]) => name !== me)) : intervals;
  const peopleLeft = stereo ? people.filter((p) => p !== me) : people;

  const overlapWith = (seg, spans) => spans.reduce((t, [a, b]) => t + Math.max(0, Math.min(seg.end, b + slack) - Math.max(seg.start, a - slack)), 0);
  const direct = segments.map((seg) => {
    if (isMine(seg)) return null;
    let best = null, most = 0;
    for (const [name, spans] of Object.entries(others)) {
      const o = overlapWith(seg, spans);
      if (o > most) { most = o; best = name; }
    }
    return best;
  });

  // Which person does each transcriber label belong to? Needs a real share of that label's talking time.
  const labels = new Set(segments.filter((s) => !isMine(s) && s.fallback).map((s) => s.fallback));
  const labelTime = {}, labelNames = {};
  segments.forEach((seg, i) => {
    if (isMine(seg) || !seg.fallback) return;
    labelTime[seg.fallback] = (labelTime[seg.fallback] || 0) + Math.max(0, seg.end - seg.start);
    if (direct[i]) {
      const m = (labelNames[seg.fallback] ||= {});
      m[direct[i]] = (m[direct[i]] || 0) + Math.max(0, seg.end - seg.start);
    }
  });
  const labelOwner = {};
  if (labels.size >= 2) {
    for (const [label, names] of Object.entries(labelNames)) {
      const [name, time] = Object.entries(names).sort((x, y) => y[1] - x[1])[0];
      if (time >= minShare * (labelTime[label] || Infinity)) labelOwner[label] = name;
    }
  }

  const out = [];
  segments.forEach((seg, i) => {
    const best = isMine(seg) ? me
      : direct[i] || labelOwner[seg.fallback] || (peopleLeft.length === 1 ? peopleLeft[0] : null) || seg.fallback || 'Speaker';
    const prev = out.at(-1);
    if (prev && prev.speaker === best && seg.start - prev.end < mergeGap) { prev.end = seg.end; prev.text += ` ${seg.text}`; }
    else out.push({ speaker: best, start: seg.start, end: seg.end, text: seg.text });
  });
  return out;
}

export function speakerStats(segments) {
  const by = new Map();
  for (const s of segments) by.set(s.speaker, (by.get(s.speaker) || 0) + Math.max(0, s.end - s.start));
  const total = [...by.values()].reduce((a, b) => a + b, 0) || 1;
  return [...by].map(([name, sec]) => ({ name, sec: Math.round(sec), pct: Math.round((sec / total) * 100) })).sort((a, b) => b.sec - a.sec);
}

// Everyone who was in the call (from the join/leave events), each with talk time. People who never spoke have 0.
// Falls back to the people who spoke when the call produced no participant events.
export function buildSpeakers(participants, segments) {
  const spoke = speakerStats(segments);
  if (!participants?.length) return spoke;
  const by = new Map(spoke.map((s) => [s.name.toLowerCase(), s]));
  const out = [], seen = new Set();
  for (const p of participants) {
    const name = String(p.name || '').trim(), key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const s = by.get(key);
    out.push({ name, sec: s?.sec || 0, pct: s?.pct || 0, host: !!p.isHost });
  }
  for (const s of spoke) if (!seen.has(s.name.toLowerCase())) out.push(s); // spoke but no join event seen
  return out.sort((a, b) => b.sec - a.sec);
}

export const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(x).padStart(2, '0')}`;
};

export const toText = (segments) => segments.map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`).join('\n');

const ts = (s, sep) => {
  const ms = Math.round((s % 1) * 1000), t = Math.floor(s);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}${sep}${p(ms, 3)}`;
};
export const toVtt = (segs) => 'WEBVTT\n\n' + segs.map((s) => `${ts(s.start, '.')} --> ${ts(s.end + 0.01, '.')}\n${s.speaker}: ${s.text}\n`).join('\n');
export const toSrt = (segs) => segs.map((s, i) => `${i + 1}\n${ts(s.start, ',')} --> ${ts(s.end + 0.01, ',')}\n${s.speaker}: ${s.text}\n`).join('\n');
