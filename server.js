// ============================================================
// SpotPrem — server online v3: Firebase + catatan aktivitas salin
// (POST /api/track publik mencatat salin/lihat password dari situs;
//  GET/DELETE /api/activity hanya untuk admin yang login.)
// Sama seperti server.js v1 (login admin, API akun, data-akun.js
// dinamis), tetapi data akun disimpan di Firebase Realtime
// Database sehingga TIDAK hilang saat server Render restart /
// deploy ulang / tidur — tanpa perlu Render Disk berbayar.
//
// Pengaturan lewat Environment Variables di Render:
//   ADMIN_PASSWORD   = password admin (WAJIB)
//   FIREBASE_DB_URL  = alamat database, contoh:
//                      https://NAMA-PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app
//                      Kalau variabel ini KOSONG, server kembali ke
//                      mode file (accounts.json) seperti v1.
//   FIREBASE_PATH    = cabang tempat data disimpan di database
//                      (bawaan: spotprem/accounts). Boleh diganti
//                      dengan akhiran acak agar sulit ditebak,
//                      mis. spotprem-x7k9/accounts
//   FIREBASE_SECRET  = (opsional) Database Secret Firebase, bila
//                      rules database-mu terkunci (auth penuh).
//   DATA_FILE        = hanya dipakai pada mode file (tanpa Firebase).
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'accounts.json');
const SEED_FILE = path.join(__dirname, 'data-akun.js');
const SESSION_MS = 12 * 60 * 60 * 1000;

const FIREBASE_DB_URL = String(process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const FIREBASE_PATH = String(process.env.FIREBASE_PATH || 'spotprem/accounts').replace(/^\/+|\/+$/g, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';
const FIREBASE_ACTIVITY_PATH = FIREBASE_PATH.replace(/[^/]+$/, 'activity');
const USE_FIREBASE = !!FIREBASE_DB_URL;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[SpotPrem] PERINGATAN: ADMIN_PASSWORD belum diatur — memakai bawaan "123456". Atur di Environment Variables Render!');
}
console.log('[SpotPrem] mode penyimpanan:', USE_FIREBASE ? 'Firebase (' + FIREBASE_DB_URL + ' / ' + FIREBASE_PATH + ')' : 'file lokal (' + DATA_FILE + ')');

/* ---------------- Util data akun ---------------- */
function parseAccountsFile(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error('array tidak ditemukan');
  return JSON.parse(text.slice(start, end + 1));
}
function seedFromFile() {
  try {
    if (fs.existsSync(SEED_FILE)) return parseAccountsFile(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch (e) { console.error('[SpotPrem] gagal membaca seed data-akun.js:', e.message); }
  return [];
}

/* ---------------- Mode file (seperti v1) ---------------- */
function saveAccountsToFile(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function loadAccountsFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('[SpotPrem] gagal membaca DATA_FILE:', e.message); }
  const seed = seedFromFile();
  if (seed.length) { try { saveAccountsToFile(seed); } catch (e) {} console.log('[SpotPrem] data awal diimpor dari data-akun.js:', seed.length, 'akun'); }
  return seed;
}

/* ---------------- Mode Firebase (REST) ---------------- */
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
async function loadAccountsFromFirebase() {
  const data = await firebaseFetch('GET');
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    // RTDB bisa mengembalikan objek bernomor bila indeks tidak rapat — urutkan kuncinya
    const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
    if (keys.length && keys.every(k => /^\d+$/.test(k))) return keys.map(k => data[k]);
  }
  return null; // belum ada data
}

/* ---------------- Penyimpanan aktivitas salin ---------------- */
const ACTIVITY_FILE = path.join(path.dirname(DATA_FILE), 'activity.json');
const ACTIVITY_MAX = 500;
let activity = [];
function loadActivityFromFile() {
  try {
    if (fs.existsSync(ACTIVITY_FILE)) {
      const a = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
      if (Array.isArray(a)) return a.slice(-ACTIVITY_MAX);
    }
  } catch (e) { console.error('[SpotPrem] gagal membaca activity.json:', e.message); }
  return [];
}
function saveActivityToFile() {
  fs.mkdirSync(path.dirname(ACTIVITY_FILE), { recursive: true });
  const tmp = ACTIVITY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(activity));
  fs.renameSync(tmp, ACTIVITY_FILE);
}
async function loadActivityFromFirebase() {
  const data = await firebaseFetch('GET', null, FIREBASE_ACTIVITY_PATH);
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const keys = Object.keys(data).sort((a, b) => Number(a) - Number(b));
    if (keys.length && keys.every(k => /^\d+$/.test(k))) return keys.map(k => data[k]);
  }
  return null;
}
async function persistActivity() {
  if (USE_FIREBASE) { await firebaseFetch('PUT', activity, FIREBASE_ACTIVITY_PATH); return; }
  saveActivityToFile();
}
async function refreshActivity() {
  if (!USE_FIREBASE) return;
  try { const r = await loadActivityFromFirebase(); if (r) activity = r; } catch (e) {}
}

/* ---------------- Penyimpanan aktif ---------------- */
let accounts = [];
async function initStore() {
  if (!USE_FIREBASE) { accounts = loadAccountsFromFile(); activity = loadActivityFromFile(); return; }
  try {
    const remote = await loadAccountsFromFirebase();
    if (remote) {
      accounts = remote;
      console.log('[SpotPrem] data dimuat dari Firebase:', accounts.length, 'akun');
    } else {
      accounts = seedFromFile();
      await firebaseFetch('PUT', accounts);
      console.log('[SpotPrem] Firebase masih kosong — data awal dari data-akun.js disimpan:', accounts.length, 'akun');
    }
  } catch (e) {
    console.error('[SpotPrem] GAGAL menghubungi Firebase saat mulai:', e.message);
    console.error('[SpotPrem] Server tetap jalan dengan data seed di memori; simpanan akan error sampai Firebase bisa dihubungi.');
    accounts = seedFromFile();
  }
  try {
    const ra = await loadActivityFromFirebase();
    activity = Array.isArray(ra) ? ra.slice(-ACTIVITY_MAX) : [];
    console.log('[SpotPrem] aktivitas dimuat dari Firebase:', activity.length, 'catatan');
  } catch (e) { activity = []; }
}
async function persistAccounts(list) {
  if (USE_FIREBASE) { await firebaseFetch('PUT', list); return; }
  saveAccountsToFile(list);
}
async function refreshFromStore() {
  if (!USE_FIREBASE) return;
  try {
    const remote = await loadAccountsFromFirebase();
    if (remote) accounts = remote;
  } catch (e) { /* abaikan: pakai data terakhir di memori */ }
}

/* ---------------- Sesi login ---------------- */
const sessions = new Map();
const loginFails = new Map();
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
  return crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function currentSession(req) {
  const token = parseCookies(req).spotprem_sess;
  if (!token) return null;
  const exp = sessions.get(token);
  if (!exp || Date.now() > exp) { sessions.delete(token); return null; }
  return token;
}
function requireAuth(req, res, next) {
  if (!currentSession(req)) return res.status(401).json({ error: 'Belum login' });
  next();
}

/* ---------------- API ---------------- */
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  if (Date.now() < rec.lockedUntil) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan salah. Coba lagi dalam 5 menit.' });
  }
  if (!passwordMatches(req.body && req.body.password)) {
    rec.count += 1;
    if (rec.count >= 5) { rec.lockedUntil = Date.now() + 5 * 60 * 1000; rec.count = 0; }
    loginFails.set(ip, rec);
    return res.status(401).json({ error: 'Password salah' });
  }
  loginFails.delete(ip);
  const token = makeToken();
  sessions.set(token, Date.now() + SESSION_MS);
  res.cookie('spotprem_sess', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_MS,
    path: '/',
  });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const token = currentSession(req);
  if (token) sessions.delete(token);
  res.clearCookie('spotprem_sess', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/accounts', requireAuth, async (req, res) => {
  await refreshFromStore();
  res.json({ accounts });
});
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
app.put('/api/accounts', requireAuth, async (req, res) => {
  const cleaned = cleanAccounts(req.body && req.body.accounts);
  if (!cleaned) return res.status(400).json({ error: 'Format data akun tidak valid' });
  try {
    await persistAccounts(cleaned);
  } catch (e) {
    console.error('[SpotPrem] gagal menyimpan:', e.message);
    return res.status(500).json({ error: 'Server gagal menyimpan data: ' + e.message.slice(0, 140) });
  }
  accounts = cleaned;
  res.json({ ok: true, count: accounts.length, active: accounts.filter(a => a.available).length });
});

/* ---------------- Aktivitas salin ----------------
   Publik boleh MENCATAT (dari tombol salin/lihat di situs).
   Membaca & membersihkan daftar hanya admin yang login. */
const trackHits = new Map();
app.post('/api/track', async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const hits = (trackHits.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= 30) { trackHits.set(ip, hits); return res.status(204).end(); }
  hits.push(now); trackHits.set(ip, hits);
  const b = req.body || {};
  const kind = ['email', 'password', 'both', 'reveal'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'kind tidak valid' });
  activity.push({
    t: new Date().toISOString(),
    email: String(b.email || '').slice(0, 200),
    plan: String(b.plan || '').slice(0, 120),
    kind,
    ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64),
    ua: String(req.headers['user-agent'] || '').slice(0, 140),
  });
  if (activity.length > ACTIVITY_MAX) activity = activity.slice(-ACTIVITY_MAX);
  try { await persistActivity(); } catch (e) { console.error('[SpotPrem] gagal menyimpan aktivitas:', e.message); }
  res.status(204).end();
});
app.get('/api/activity', requireAuth, async (req, res) => {
  await refreshActivity();
  res.json({ total: activity.length, activity: activity.slice(-200).reverse() });
});
/* Ringkasan PUBLIK untuk lencana "sudah disalin" di kartu akun.
   Hanya berisi jumlah salin/lihat + waktu terakhir per email —
   TANPA alamat IP dan TANPA info perangkat. */
let lastStatsRefresh = 0;
app.get('/api/copystats', async (req, res) => {
  if (USE_FIREBASE && Date.now() - lastStatsRefresh > 30000) { lastStatsRefresh = Date.now(); await refreshActivity(); }
  const stats = {};
  for (const e of activity) {
    if (!e || !e.email) continue;
    const st = stats[e.email] || (stats[e.email] = { copies: 0, views: 0, last: null, lastView: null });
    if (e.kind === 'reveal') { st.views += 1; if (!st.lastView || e.t > st.lastView) st.lastView = e.t; }
    else { st.copies += 1; if (!st.last || e.t > st.last) st.last = e.t; }
  }
  res.set('Cache-Control', 'no-store');
  res.json({ stats });
});
app.delete('/api/activity', requireAuth, async (req, res) => {
  activity = [];
  try { await persistActivity(); } catch (e) { return res.status(500).json({ error: 'Gagal membersihkan: ' + e.message.slice(0, 120) }); }
  res.json({ ok: true });
});

app.get('/data-akun.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send('const accounts = ' + JSON.stringify(accounts) + ';\n');
});

app.get('/api/health', (req, res) => res.json({ ok: true, accounts: accounts.length, activity: activity.length, storage: USE_FIREBASE ? 'firebase' : 'file' }));

app.use(express.static(__dirname));

initStore()
  .catch(e => console.error('[SpotPrem] initStore error:', e.message))
  .finally(() => app.listen(PORT, () => console.log('[SpotPrem] server jalan di port', PORT, '| akun:', accounts.length)));
