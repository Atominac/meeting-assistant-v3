// The desktop SDK reports the call window's title. For a scheduled call that is the real meeting name;
// for an instant call it is often just the app name or a join code, which is not worth showing.
const GENERIC = /^(zoom( workplace| meeting)?|zoom\.us|google meet|meet|meeting|microsoft teams( meeting)?|teams|untitled|new meeting)$/i;
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i; // Google Meet join code, e.g. abc-defg-hij

export function cleanTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(google )?meet\s*[-–—:]\s*/i, '').replace(/\s*[-–—|]\s*(google meet|zoom( workplace)?|microsoft teams)$/i, '').trim();
  if (!t || GENERIC.test(t) || CODE.test(t)) return '';
  return t.slice(0, 200);
}
