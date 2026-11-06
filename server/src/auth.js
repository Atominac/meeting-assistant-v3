import crypto from 'node:crypto';
import { env } from './env.js';
import { col } from './db.js';

const SECRET = env.sessionSecret || crypto.randomBytes(32).toString('hex'); // only signs short-lived media/OAuth links
const b64u = (b) => Buffer.from(b).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

// Short-lived signed links (video URLs, Google OAuth state). Not used for login.
export function sign(payload, ttlSec) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${mac(body)}`;
}
export function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}

// ---------- passwords ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scrypt = (pw, salt, o) => new Promise((res, rej) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
const DUMMY = hashPassword('not-a-real-password'); // burns the same time when the email is unknown
export async function checkPassword(pw, stored) {
  const [, N, r, p, salt, key] = String(stored || (await DUMMY)).split('$');
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, keylen: want.length });
  return crypto.timingSafeEqual(want, got) && !!stored;
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
export const passwordProblem = (pw) =>
  typeof pw !== 'string' || pw.length < 8 ? 'Use at least 8 characters.' : pw.length > 200 ? 'That password is too long.' : null;

// ---------- sessions (one per signed-in browser or computer; revocable) ----------
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const LIFETIME = { web: 30, desktop: 90 }; // days, renewed whenever the session is used

export async function createSession(user, { kind = 'web', label = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const days = LIFETIME[kind] || 30;
  await col('sessions').insertOne({
    _id: crypto.randomUUID(), tokenHash: hash(token), uid: user._id, kind, label: String(label).slice(0, 80),
    createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + days * 864e5),
  });
  return token;
}

// askToRecord: pop up "Record this meeting?" whenever the desktop app detects a call. On unless the user turned it off.
export const prefsOf = (u) => ({ askToRecord: u?.prefs?.askToRecord !== false });
export const publicUser = (u) => ({ id: u._id, name: u.name, email: u.email, prefs: prefsOf(u) });

// Bearer-token auth for both the web page and the desktop app.
export async function requireUser(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = t && await col('sessions').findOne({ tokenHash: hash(t), expiresAt: { $gt: new Date() } });
  const u = s && await col('users').findOne({ _id: s.uid });
  if (!u) return res.status(401).json({ error: 'Please sign in' });
  req.session = s;
  req.user = { uid: u._id, name: u.name, email: u.email, prefs: prefsOf(u) };
  if (Date.now() - s.lastSeenAt > 10 * 60_000) {
    col('sessions').updateOne({ _id: s._id }, { $set: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + (LIFETIME[s.kind] || 30) * 864e5) } }).catch(() => {});
  }
  next();
}

// ---------- brute-force guard (per IP + email) ----------
const attempts = new Map();
export function throttle(key, max = 8, windowMs = 15 * 60_000) {
  const now = Date.now(), a = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) return Math.ceil((windowMs - (now - a[0])) / 60_000);
  a.push(now); attempts.set(key, a);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((t) => now - t < windowMs)) attempts.delete(k);
  return 0;
}
export const clearThrottle = (key) => attempts.delete(key);
