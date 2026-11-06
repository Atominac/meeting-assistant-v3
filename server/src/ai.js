import OpenAI from 'openai';
import { env } from './env.js';
import { toText, fmt } from './transcript.js';
import { templateById } from './templates.js';

let client;
export const aiConfigured = () => !!env.openaiKey;
const openai = () => (client ||= new OpenAI({ apiKey: env.openaiKey }));

const MAX_CHARS = 380_000; // roughly 95k tokens of transcript per request

const SUMMARY_PROMPT = `You write meeting notes. Read the transcript (lines look like "[m:ss] Speaker: text") and reply with ONLY a JSON object:
{
  "title": "short specific title, max 8 words",
  "overview": "2-4 sentence summary",
  "keyPoints": ["..."],
  "decisions": ["..."],
  "actionItems": [{"owner": "name or null", "task": "...", "due": "date text or null"}],
  "chapters": [{"start": <seconds from start>, "title": "..."}],
  "topics": ["1-3 word tags"]
}
Use only what is in the transcript. Empty arrays are fine. Chapters: 3-10, ascending "start", the first at 0.`;

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(a, b + 1));
}

export async function summarize(meeting, templateId) {
  const tpl = templateById(templateId);
  const transcript = toText(meeting.segments || []).slice(0, MAX_CHARS);
  if (!transcript) throw new Error('No transcript to summarize');
  const attendees = (meeting.attendees || []).map((a) => a.name || a.email).filter(Boolean).join(', ');
  const res = await openai().chat.completions.create({
    model: env.aiModel,
    max_completion_tokens: 4000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${SUMMARY_PROMPT}\nTemplate: ${tpl.label}. ${tpl.focus}` },
      { role: 'user', content: `${meeting.title ? `Calendar title: ${meeting.title}\n` : ''}${attendees ? `Invited: ${attendees}\n` : ''}\n${transcript}` },
    ],
  });
  const s = parseJson(res.choices[0]?.message?.content || '');
  return {
    title: String(s.title || ''), overview: String(s.overview || ''),
    keyPoints: s.keyPoints || [], decisions: s.decisions || [], actionItems: s.actionItems || [],
    chapters: (s.chapters || []).filter((c) => Number.isFinite(c.start)).sort((a, b) => a.start - b.start),
    topics: s.topics || [], template: tpl.id, model: env.aiModel, at: new Date(),
  };
}

const CHAT_SYSTEM = `You are the assistant inside a meeting recorder. Answer questions about the recorded meetings given below, using only that material. If the answer is not there, say so plainly.
Style: concise, concrete, no filler. Use short paragraphs, bullet lists, and **bold** for names and decisions. Use fenced code blocks for ASCII tables or diagrams when the user asks for a table, timeline or chart.
Citations: whenever you state something from a meeting, add a marker [[<meeting id>@<seconds>]] right after it, using the id and the start second of the transcript line (the context shows lines as "[m:ss|<seconds>]"). Example: Pricing was approved [[abc123@754]]. Never invent ids or times.`;

const words = (q) => [...new Set(q.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];

// One meeting: the whole transcript. Many meetings: every summary + the best-matching transcript excerpts.
export function buildContext(meetings, question, single) {
  const line = (m, s) => `[${fmt(s.start)}|${Math.floor(s.start)}] ${s.speaker}: ${s.text}`;
  const head = (m) => `### Meeting id=${m._id} "${m.title}" (${new Date(m.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, ${m.platform || 'meeting'})`;
  if (single) {
    const m = meetings[0];
    const sum = m.summary ? `Summary: ${m.summary.overview}\n` : '';
    return `${head(m)}\n${sum}${(m.segments || []).map((s) => line(m, s)).join('\n')}`.slice(0, MAX_CHARS);
  }
  const q = words(question);
  const scored = [];
  for (const m of meetings) (m.segments || []).forEach((s, i) => {
    const t = s.text.toLowerCase();
    const score = q.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
    if (score) scored.push({ m, i, score });
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = new Map();
  for (const { m, i } of scored.slice(0, 40)) {
    const set = picked.get(m._id) || new Set();
    [i - 1, i, i + 1].forEach((j) => m.segments[j] && set.add(j));
    picked.set(m._id, set);
  }
  const parts = meetings.map((m) => {
    const sum = m.summary ? `Summary: ${m.summary.overview}\nDecisions: ${(m.summary.decisions || []).join('; ')}\nAction items: ${(m.summary.actionItems || []).map((a) => `${a.owner || '?'}: ${a.task}`).join('; ')}\n` : '';
    const ex = [...(picked.get(m._id) || [])].sort((a, b) => a - b).map((j) => line(m, m.segments[j])).join('\n');
    return `${head(m)}\n${sum}${ex ? `Relevant lines:\n${ex}` : ''}`;
  });
  return parts.join('\n\n').slice(0, MAX_CHARS);
}

export async function streamChat({ context, messages, onText }) {
  const stream = await openai().chat.completions.create({
    model: env.aiModel,
    max_completion_tokens: 2500,
    stream: true,
    messages: [{ role: 'system', content: `${CHAT_SYSTEM}\n\n<meetings>\n${context}\n</meetings>` }, ...messages],
  });
  for await (const chunk of stream) { const t = chunk.choices[0]?.delta?.content; if (t) onText(t); }
}
