import { col } from './db.js';
import { env } from './env.js';
import { sign, verify } from './auth.js';

export const calendarConfigured = () => !!(env.googleClientId && env.googleClientSecret);
const REDIRECT = () => `${env.publicUrl}/api/calendar/google/callback`;

export function authUrl(user) {
  const state = sign({ uid: user.uid }, 600);
  const q = new URLSearchParams({
    client_id: env.googleClientId, redirect_uri: REDIRECT(), response_type: 'code', state,
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline', prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenCall(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.googleClientId, client_secret: env.googleClientSecret, ...params }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || 'Google token error');
  return j;
}

export async function handleCallback(code, state) {
  const user = verify(state);
  if (!user) throw new Error('Link expired, try connecting again');
  const t = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT() });
  const email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email;
  const prev = await col('calendar_accounts').findOne({ uid: user.uid });
  await col('calendar_accounts').updateOne({ uid: user.uid }, {
    $set: {
      provider: 'google', email, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000,
      refreshToken: t.refresh_token || prev?.refreshToken, connectedAt: new Date(),
    },
  }, { upsert: true });
  await syncCalendar({ uid: user.uid });
  return email;
}

async function accessToken(acct) {
  if (acct.accessToken && acct.expiresAt > Date.now() + 60_000) return acct.accessToken;
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: acct.refreshToken });
  await col('calendar_accounts').updateOne({ _id: acct._id }, { $set: { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 } });
  return t.access_token;
}

const LINK = {
  meet: /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,
  zoom: /https:\/\/[\w.-]*zoom\.(?:us|com)\/j\/\d+[^\s"<)]*/i,
  teams: /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<)]+/i,
};
export function findLink(...texts) {
  const s = texts.filter(Boolean).join(' ');
  for (const [platform, re] of Object.entries(LINK)) { const m = s.match(re); if (m) return { platform, url: m[0] }; }
  return {};
}

export function mapEvent(e) {
  const entry = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  const { platform, url } = findLink(e.hangoutLink, entry, e.location, e.description);
  const start = e.start?.dateTime || e.start?.date, end = e.end?.dateTime || e.end?.date;
  return {
    eventId: e.id, title: e.summary || '(No title)', start: new Date(start), end: new Date(end), allDay: !e.start?.dateTime,
    platform: platform || null, url: url || null, location: e.location || null,
    organizer: e.organizer?.displayName || e.organizer?.email || null,
    attendees: (e.attendees || []).map((a) => ({ name: a.displayName || null, email: a.email, self: !!a.self, status: a.responseStatus })),
    htmlLink: e.htmlLink,
  };
}

export async function syncCalendar({ uid }, days = { back: 7, ahead: 21 }) {
  const acct = await col('calendar_accounts').findOne({ uid });
  if (!acct) throw new Error('No calendar connected');
  const token = await accessToken(acct);
  const q = new URLSearchParams({
    timeMin: new Date(Date.now() - days.back * 864e5).toISOString(), timeMax: new Date(Date.now() + days.ahead * 864e5).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '250', conferenceDataVersion: '1',
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || 'Calendar sync failed');
  const events = (j.items || []).filter((e) => e.status !== 'cancelled').map(mapEvent)
    .filter((e) => !e.attendees.some((a) => a.self && a.status === 'declined'));
  const ops = events.map((e) => ({ updateOne: { filter: { uid, eventId: e.eventId, start: e.start }, update: { $set: { uid, ...e } }, upsert: true } }));
  if (ops.length) await col('calendar_events').bulkWrite(ops);
  await col('calendar_events').deleteMany({ uid, start: { $gte: new Date(q.get('timeMin')) }, eventId: { $nin: events.map((e) => e.eventId) } });
  await col('calendar_accounts').updateOne({ _id: acct._id }, { $set: { syncedAt: new Date() } });
  return events.length;
}

// Keep each connected calendar fresh in the background.
export function startCalendarSync() {
  if (!calendarConfigured()) return;
  const run = async () => {
    for (const a of await col('calendar_accounts').find().toArray()) await syncCalendar(a).catch((e) => console.error('calendar sync:', e.message));
  };
  setInterval(run, 10 * 60_000).unref();
  run();
}

const code = (url) => url && (url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i)?.[1] || url.match(/\/j\/(\d+)/)?.[1] || url.match(/meetup-join\/([^/?]+)/)?.[1])?.toLowerCase();

// Which calendar event is this recording? Same meeting link first, else the event happening now.
export async function matchEvent({ uid }, { url, platform, at = new Date() }) {
  const near = await col('calendar_events').find({
    uid, allDay: false, start: { $lte: new Date(+at + 15 * 60_000) }, end: { $gte: new Date(+at - 15 * 60_000) },
  }).toArray();
  const c = code(url);
  return near.find((e) => c && code(e.url) === c)
    || near.find((e) => e.url && (!platform || platform === 'unknown' || e.platform === platform.replace('google-', '')) && e.start <= at && e.end >= at)
    || null;
}
