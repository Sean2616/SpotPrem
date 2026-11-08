// Tes end-to-end paket Vercel dengan Firebase tiruan lokal.
// Mensimulasikan cara Vercel memanggil handler (req, res) Node,
// TERMASUK cold start: modul di-require ulang dari nol, cookie
// sesi lama harus tetap diterima (bukti sesi stateless).
const http = require('http');
const assert = require('assert');
const path = require('path');

const API = path.join(__dirname, '..', 'api');
const store = new Map(); // path Firebase -> value

const fbServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const key = decodeURIComponent(req.url.replace(/^\//, '').replace(/\.json.*$/, ''));
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(store.has(key) ? store.get(key) : null));
    } else if (req.method === 'PUT') {
      store.set(key, JSON.parse(raw || 'null'));
      res.setHeader('Content-Type', 'application/json');
      res.end(raw);
    } else { res.statusCode = 405; res.end(); }
  });
});

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(n) { this.statusCode = n; return this; },
    json(obj) { this.body = obj; return this; },
    send(text) { this.body = text; return this; },
    end() { return this; },
  };
}
async function call(handler, { method = 'GET', body, cookie, ip = '203.0.113.7', ua = 'test-agent' } = {}) {
  const req = {
    method, body,
    headers: { 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'user-agent': ua, ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: ip },
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}
function freshRequire(name) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(API)) delete require.cache[k];
  return require(path.join(API, name));
}

(async () => {
  await new Promise(r => fbServer.listen(0, '127.0.0.1', r));
  process.env.FIREBASE_DB_URL = 'http://127.0.0.1:' + fbServer.address().port;
  process.env.ADMIN_PASSWORD = 'test-admin-123';
  // env harus terbaca saat _lib di-require pertama kali:
  let health = freshRequire('health.js');
  let dataAkun = require(path.join(API, 'data-akun.js'));
  let accountsH = require(path.join(API, 'accounts.js'));
  let login = require(path.join(API, 'login.js'));
  let logout = require(path.join(API, 'logout.js'));
  let track = require(path.join(API, 'track.js'));
  let copystats = require(path.join(API, 'copystats.js'));
  let activityH = require(path.join(API, 'activity.js'));

  let n = 0; const ok = (cond, msg) => { assert(cond, msg); n++; console.log('  ok -', msg); };

  // 1. health: Firebase kosong -> seed 1 akun, activity 0
  let r = await call(health, {});
  ok(r.statusCode === 200 && r.body.ok && r.body.accounts === 1 && r.body.activity === 0 && r.body.runtime === 'vercel', 'health: seed 1 akun, activity 0, runtime vercel');

  // 2. data-akun.js dinamis berisi seed
  r = await call(dataAkun, {});
  ok(r.statusCode === 200 && typeof r.body === 'string' && r.body.includes('const accounts =') && r.body.includes('uauzhhhp77@spotprem.me'), 'data-akun: JS dinamis berisi akun seed');
  ok(store.get('spotprem/accounts').length === 1, 'data-akun: seed tertanam ke Firebase tiruan');

  // 3. accounts tanpa login -> 401
  r = await call(accountsH, {});
  ok(r.statusCode === 401, 'accounts tanpa login: 401');

  // 4. login salah -> 401, login benar -> cookie sesi
  r = await call(login, { method: 'POST', body: { password: 'salah' } });
  ok(r.statusCode === 401, 'login password salah: 401');
  r = await call(login, { method: 'POST', body: { password: 'test-admin-123' } });
  ok(r.statusCode === 200 && r.body.ok, 'login benar: 200');
  const setCookie = r.headers['set-cookie'];
  ok(typeof setCookie === 'string' && setCookie.startsWith('spotprem_sess=') && setCookie.includes('HttpOnly'), 'login: cookie HttpOnly terbit');
  const cookie = setCookie.split(';')[0];

  // 5. accounts dengan cookie -> 200
  r = await call(accountsH, { cookie });
  ok(r.statusCode === 200 && r.body.accounts.length === 1, 'accounts dengan sesi: 200, 1 akun');

  // 6. COLD START: modul dimuat ulang dari nol, cookie lama tetap sah
  accountsH = freshRequire('accounts.js');
  r = await call(accountsH, { cookie });
  ok(r.statusCode === 200, 'cold start: cookie sesi lama tetap diterima (stateless)');
  login = require(path.join(API, 'login.js')); logout = require(path.join(API, 'logout.js'));
  track = require(path.join(API, 'track.js')); copystats = require(path.join(API, 'copystats.js'));
  activityH = require(path.join(API, 'activity.js')); dataAkun = require(path.join(API, 'data-akun.js'));

  // 7. cookie dipalsukan -> 401
  const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  r = await call(accountsH, { cookie: tampered });
  ok(r.statusCode === 401, 'cookie dipalsukan: 401');

  // 8. PUT akun baru -> data-akun ikut berubah
  const baru = [{ id: 5, plan: 'Premium 1 Bulan', region: 'Region ID', email: 'baru@spotprem.me', password: 'pw-baru', status: 'Aktif', available: true, updatedAt: 'Baru saja' }];
  r = await call(accountsH, { method: 'PUT', cookie, body: { accounts: baru } });
  ok(r.statusCode === 200 && r.body.count === 1 && r.body.active === 1, 'PUT accounts: tersimpan');
  r = await call(dataAkun, {});
  ok(r.body.includes('baru@spotprem.me') && !r.body.includes('uauzhhhp77'), 'data-akun: mencerminkan PUT');

  // 9. track + copystats (publik, tanpa ip/ua)
  r = await call(track, { method: 'POST', body: { kind: 'both', email: 'baru@spotprem.me', plan: 'Premium 1 Bulan' } });
  ok(r.statusCode === 204, 'track both: 204');
  r = await call(track, { method: 'POST', body: { kind: 'reveal', email: 'baru@spotprem.me', plan: 'Premium 1 Bulan' } });
  ok(r.statusCode === 204, 'track reveal: 204');
  r = await call(track, { method: 'POST', body: { kind: 'ngawur', email: 'x@y.z' } });
  ok(r.statusCode === 400, 'track kind tidak valid: 400');
  r = await call(copystats, {});
  const st = r.body.stats['baru@spotprem.me'];
  ok(st && st.copies === 1 && st.views === 1 && st.last, 'copystats: copies 1, views 1');
  ok(!JSON.stringify(r.body).includes('203.0.113') && !JSON.stringify(r.body).includes('test-agent'), 'copystats: tanpa IP/UA (publik aman)');

  // 10. activity khusus admin: berisi IP, DELETE membersihkan badge
  r = await call(activityH, {});
  ok(r.statusCode === 401, 'activity tanpa login: 401');
  r = await call(activityH, { cookie });
  ok(r.statusCode === 200 && r.body.total === 2 && JSON.stringify(r.body).includes('203.0.113.7'), 'activity admin: 2 catatan + IP tampil');
  r = await call(activityH, { method: 'DELETE', cookie });
  ok(r.statusCode === 200, 'activity DELETE: ok');
  r = await call(copystats, {});
  ok(Object.keys(r.body.stats).length === 0, 'setelah DELETE: copystats kosong (badge hilang)');

  // 11. logout menghapus cookie
  r = await call(logout, { method: 'POST', cookie });
  ok(r.statusCode === 200 && String(r.headers['set-cookie']).includes('Max-Age=0'), 'logout: cookie dihapus');

  // 12. method salah -> 405
  r = await call(track, { method: 'GET' });
  ok(r.statusCode === 405, 'track GET: 405');

  console.log('\nSEMUA ' + n + ' PEMERIKSAAN LULUS');
  fbServer.close();
})().catch(e => { console.error('GAGAL:', e); process.exit(1); });
