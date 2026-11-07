// ============================================================
// SpotPrem — server online v2: penyimpanan Firebase (GRATIS)
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
function firebaseUrl() {
  const base = FIREBASE_DB_URL + '/' + FIREBASE_PATH + '.json';
  return FIREBASE_SECRET ? base + '?auth=' + encodeURIComponent(FIREBASE_SECRET) : base;
}
async function firebaseFetch(method, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(firebaseUrl(), {
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

/* ---------------- Penyimpanan aktif ---------------- */
let accounts = [];
async function initStore() {
  if (!USE_FIREBASE) { accounts = loadAccountsFromFile(); return; }
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

app.get('/data-akun.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send('const accounts = ' + JSON.stringify(accounts) + ';\n');
});

app.get('/api/health', (req, res) => res.json({ ok: true, accounts: accounts.length, storage: USE_FIREBASE ? 'firebase' : 'file' }));

app.use(express.static(__dirname));

initStore()
  .catch(e => console.error('[SpotPrem] initStore error:', e.message))
  .finally(() => app.listen(PORT, () => console.log('[SpotPrem] server jalan di port', PORT, '| akun:', accounts.length)));
