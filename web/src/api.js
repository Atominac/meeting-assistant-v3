let token = null;
let onAuthLost = () => {};
export const setToken = (t) => { token = t; };
export const setAuthLostHandler = (fn) => { onAuthLost = fn; };

async function request(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) onAuthLost(); // session revoked or expired elsewhere
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body: body ?? {} }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
  text: async (p) => (await request(p, { raw: true })).text(),
};

// Streams an answer from /api/chat; calls onText with each chunk.
export async function streamChat({ meetingId, messages, onText, signal }) {
  const res = await request('/chat', { method: 'POST', body: { meetingId, messages }, raw: true });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || 'Chat failed');
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    if (signal?.aborted) { reader.cancel(); return; }
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, ''); buf = buf.slice(i + 2);
      if (line === '[DONE]') return;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.t) onText(j.t);
    }
  }
}
