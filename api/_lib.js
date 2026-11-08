// ============================================================
// SpotPrem — pustaka bersama untuk Vercel Serverless Functions.
// Pengganti server.js (Express di Render) versi AKTIVITAS2.
//
// Perbedaan penting dari versi Render:
//  - Tidak ada app.listen dan tidak ada state sesi di memori.
//    Sesi admin = cookie bertanda tangan HMAC (stateless), jadi
//    tetap valid walau request berikutnya dilayani instance
//    serverless yang berbeda / cold start.
//  - Penyimpanan HANYA Firebase RTDB (mode file tidak ada:
//    filesystem Vercel tidak permanen).
//  - Batas gagal login & batas /api/track per IP bersifat
//    best-effort per instance hangat (sama seperti keterbatasan
//    yang sudah disampaikan sebelum paket ini dibuat).
//
// Environment Variables di Vercel (Project Settings > Env Vars):
//   ADMIN_PASSWORD   (WAJIB) password admin, sama seperti di Render
//   FIREBASE_DB_URL  (WAJIB) contoh:
//                    https://NAMA-PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app
//   FIREBASE_PATH    (opsional) bawaan: spotprem/accounts
//   FIREBASE_SECRET  (opsional) bila rules Firebase terkunci
//   SESSION_SECRET   (opsional) kunci tanda tangan sesi; bila kosong
//                    memakai ADMIN_PASSWORD. Mengganti ini (atau
//                    password admin) meng-logout semua sesi aktif.
// ============================================================
const crypto = require('crypto');
const SEED = require('./_seed');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const SESSION_MS = 12 * 60 * 60 * 1000;
const ACTIVITY_MAX = 500;

const FIREBASE_DB_URL = String(process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const FIREBASE_PATH = String(process.env.FIREBASE_PATH || 'spotprem/accounts').replace(/^\/+|\/+$/g, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const FIREBASE_ACTIVITY_PATH = FIREBASE_PATH.replace(/[^/]+$/, 'activity');

/* ---------------- Firebase REST ---------------- */
function firebaseUrl(p) {
  const base = FIREBASE_DB_URL + '/' + (p || FIREBASE_PATH) + '.json';
  return FIREBASE_SECRET ? base + '?auth=' + encodeURIComponent(FIREBASE_SECRET) : base;
}
async function firebaseFetch(method, body, p) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(firebaseUrl(p), {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('Firebase HTTP ' + res.status + ': ' + text.slice(0, 160));
    try { return JSON.parse(text); } catch (e) { return null; }
  } finally { clearTimeout(timer); }
}
function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
    if (keys.length && keys.every(k => /^\d+$/.test(k))) return keys.map(k => data[k]);
  }
  return null;
}
async function loadAccounts() {
  const remote = asArray(await firebaseFetch('GET'));
  if (remote) return remote;
  // Firebase kosong: tanam seed sekali, seperti initStore versi Render.
  try { await firebaseFetch('PUT', SEED); } catch (e) { /* data-akun tetap menyajikan seed */ }
  return SEED.slice();
}
async function saveAccounts(list) { await firebaseFetch('PUT', list); }
async function loadActivity() {
  const remote = asArray(await firebaseFetch('GET', null, FIREBASE_ACTIVITY_PATH));
  return remote ? remote.slice(-ACTIVITY_MAX) : [];
}
async function saveActivity(list) { await firebaseFetch('PUT', list.slice(-ACTIVITY_MAX), FIREBASE_ACTIVITY_PATH); }

/* ---------------- Sesi admin stateless ---------------- */
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest();
}
function makeSessionCookieValue() {
  const payloadB64 = b64url(JSON.stringify({ exp: Date.now() + SESSION_MS }));
  return payloadB64 + '.' + b64url(sign(payloadB64));
}
function verifySessionCookieValue(value) {
  if (!value || typeof value !== 'string') return false;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;
  const payloadB64 = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = sign(payloadB64);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() <= payload.exp;
  } catch (e) { return false; }
}
function parseCookies(req) {
  const out = {};
  String((req.headers && req.headers.cookie) || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) { return verifySessionCookieValue(parseCookies(req).spotprem_sess); }
function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
  return crypto.timingSafeEqual(a, b);
}
function sessionCookieHeader(req) {
  const secure = (req.headers && (req.headers['x-forwarded-proto'] === 'https')) ? '; Secure' : '';
  return 'spotprem_sess=' + makeSessionCookieValue() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_MS / 1000) + secure;
}
function clearCookieHeader() {
  return 'spotprem_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

/* ---------------- Batas per IP (best-effort, per instance) ---------------- */
const loginFails = new Map();
const trackHits = new Map();
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  return String(xff || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}
function loginLocked(ip) {
  const rec = loginFails.get(ip);
  return !!(rec && Date.now() < rec.lockedUntil);
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.lockedUntil = Date.now() + 5 * 60 * 1000; rec.count = 0; }
  loginFails.set(ip, rec);
}
function clearLoginFails(ip) { loginFails.delete(ip); }
function trackRateLimited(ip) {
  const now = Date.now();
  const hits = (trackHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 30) { trackHits.set(ip, hits); return true; }
  hits.push(now); trackHits.set(ip, hits);
  return false;
}

/* ---------------- Validasi akun (sama seperti versi Render) ---------------- */
function cleanAccounts(input) {
  if (!Array.isArray(input)) return null;
  if (input.length > 500) return null;
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const usedIds = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    let id = Number(raw.id);
    if (!Number.isFinite(id) || id <= 0 || usedIds.has(id)) id = 1;
    while (usedIds.has(id)) id += 1;
    usedIds.add(id);
    out.push({
      id,
      plan: str(raw.plan, 120),
      region: str(raw.region, 160),
      email: str(raw.email, 200),
      password: str(raw.password, 200),
      status: str(raw.status, 60) || 'Aktif',
      available: !!raw.available,
      updatedAt: str(raw.updatedAt, 60) || 'Baru saja',
    });
  }
  return out;
}

/* ---------------- Util respons ---------------- */
function bodyOf(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return req.body;
}
function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return res.status(405).json({ error: 'Method tidak diizinkan' });
}
function serverError(res, e, prefix) {
  console.error('[SpotPrem]', prefix || 'error:', e && e.message);
  return res.status(500).json({ error: 'Server gagal: ' + String((e && e.message) || e).slice(0, 140) });
}

module.exports = {
  FIREBASE_DB_URL, SESSION_MS, ACTIVITY_MAX,
  loadAccounts, saveAccounts, loadActivity, saveActivity,
  isAuthed, passwordMatches, sessionCookieHeader, clearCookieHeader,
  loginLocked, noteLoginFail, clearLoginFails, trackRateLimited, clientIp,
  cleanAccounts, bodyOf, methodNotAllowed, serverError,
};
