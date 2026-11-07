// ============================================================
// SpotPrem — server online (untuk Render)
// - Menyajikan index.html, admin.html, dan file statis lain
// - GET  /data-akun.js   -> dibuat otomatis dari data tersimpan,
//                           jadi index.html TIDAK perlu diubah
// - POST /api/login      -> login admin (password dari env ADMIN_PASSWORD)
// - GET  /api/accounts   -> daftar akun (harus login)
// - PUT  /api/accounts   -> simpan daftar akun (harus login)
//
// Pengaturan lewat Environment Variables di Render:
//   ADMIN_PASSWORD = password admin (WAJIB diganti dari bawaan)
//   DATA_FILE      = lokasi file data, mis. /var/data/accounts.json
//                    (isi dengan jalur Render Disk agar data TIDAK
//                     hilang saat server restart / deploy ulang.
//                     Tanpa disk, file di folder project bersifat
//                     sementara di Render.)
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
const SESSION_MS = 12 * 60 * 60 * 1000; // sesi login 12 jam

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[SpotPrem] PERINGATAN: ADMIN_PASSWORD belum diatur — memakai bawaan "123456". Atur di Environment Variables Render!');
}

/* ---------------- Penyimpanan akun ---------------- */
function parseAccountsFile(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error('array tidak ditemukan');
  return JSON.parse(text.slice(start, end + 1));
}
function saveAccounts(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function loadAccounts() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('[SpotPrem] gagal membaca DATA_FILE:', e.message); }
  // Pertama kali jalan: impor data-akun.js yang sudah ada sebagai data awal
  try {
    if (fs.existsSync(SEED_FILE)) {
      const seed = parseAccountsFile(fs.readFileSync(SEED_FILE, 'utf8'));
      saveAccounts(seed);
      console.log('[SpotPrem] data awal diimpor dari data-akun.js:', seed.length, 'akun');
      return seed;
    }
  } catch (e) { console.error('[SpotPrem] gagal impor data-akun.js:', e.message); }
  return [];
}
let accounts = loadAccounts();

/* ---------------- Sesi login ---------------- */
const sessions = new Map(); // token -> waktu kedaluwarsa (ms)
const loginFails = new Map(); // ip -> { count, lockedUntil }
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
app.get('/api/accounts', requireAuth, (req, res) => {
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
app.put('/api/accounts', requireAuth, (req, res) => {
  const cleaned = cleanAccounts(req.body && req.body.accounts);
  if (!cleaned) return res.status(400).json({ error: 'Format data akun tidak valid' });
  try {
    saveAccounts(cleaned);
  } catch (e) {
    console.error('[SpotPrem] gagal menyimpan:', e.message);
    return res.status(500).json({ error: 'Server gagal menyimpan data (penyimpanan tidak bisa ditulis)' });
  }
  accounts = cleaned;
  res.json({ ok: true, count: accounts.length, active: accounts.filter(a => a.available).length });
});

/* data-akun.js dinamis — index.html tetap memuat file ini seperti biasa */
app.get('/data-akun.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send('const accounts = ' + JSON.stringify(accounts) + ';\n');
});

app.get('/api/health', (req, res) => res.json({ ok: true, accounts: accounts.length }));

/* File statis (index.html, admin.html, gambar, dll) */
app.use(express.static(__dirname));

app.listen(PORT, () => console.log('[SpotPrem] server jalan di port', PORT, '| akun tersimpan:', accounts.length, '| file data:', DATA_FILE));
