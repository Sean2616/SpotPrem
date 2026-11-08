// ============================================================
// SpotPrem — entrypoint tunggal (server.js) untuk Vercel.
// v3 (2026-11-08): deployment b64bfc4 di Vercel statusnya
// Ready ("Using server.js as the root entrypoint") tapi semua
// request menjawab FUNCTION_INVOCATION_FAILED, dan log runtime
// lama menunjukkan file ini berjalan sebagai FUNGSI Lambda
// (/var/task/server.cjs), bukan sebagai service yang listen.
// Di mode fungsi, file entry TIDAK BOLEH memanggil listen()
// saat di-require — ia harus MENGEKSPOR fungsi handler
// (req, res). Karena itu v3:
//   - module.exports = handler(req, res)  -> dipakai Vercel
//   - listen() HANYA bila file dijalankan langsung
//     (node server.js)                    -> dipakai Render
//     dan pengujian lokal, persis seperti sebelumnya.
// Tanpa Express / dependensi apa pun — hanya Node bawaan.
// Tugasnya sama: statis (index/admin/player.html) + meneruskan
// /api/* dan /data-akun.js ke handler di folder api/.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/admin.html': 'admin.html',
  '/player.html': 'player.html',
};
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// Literal path.join agar penelusuran file bundler Vercel (nft)
// memasukkan ketiga HTML ini ke dalam paket fungsi:
const TRACED_FILES = [
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'admin.html'),
  path.join(__dirname, 'player.html'),
];
void TRACED_FILES;

const ROUTES = {
  '/api/login': require('./api/login'),
  '/api/logout': require('./api/logout'),
  '/api/accounts': require('./api/accounts'),
  '/api/activity': require('./api/activity'),
  '/api/track': require('./api/track'),
  '/api/copystats': require('./api/copystats'),
  '/api/health': require('./api/health'),
  '/api/data-akun': require('./api/data-akun'),
  '/data-akun.js': require('./api/data-akun'),
};

/* Di mode fungsi (Vercel), req.body SUDAH diparse oleh platform
   dan res SUDAH punya .status()/.json()/.send(). Di mode server
   langsung (Render/lokal), keduanya mentah — wrapRes/readBody
   menormalkan supaya handler api/ bekerja sama di dua mode. */
function wrapRes(res) {
  if (typeof res.status !== 'function') {
    res.status = n => { res.statusCode = n; return res; };
  }
  if (typeof res.json !== 'function') {
    res.json = obj => {
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(obj));
      return res;
    };
  }
  if (typeof res.send !== 'function') {
    res.send = text => { res.end(text); return res; };
  }
  return res;
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      if (String(req.headers['content-type'] || '').includes('application/json')) {
        try { return resolve(JSON.parse(raw)); } catch (e) { return resolve(undefined); }
      }
      resolve(raw);
    });
    req.on('error', () => resolve(undefined));
  });
}

async function handler(req, res) {
  wrapRes(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    const route = ROUTES[pathname];
    if (route) {
      // Hanya baca body mentah bila platform belum memparse-nya
      // (mode server langsung). Di mode fungsi Vercel, req adalah
      // stream yang sudah dikonsumsi platform — jangan dibaca lagi.
      if (req.body === undefined && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')) {
        req.body = await readBody(req);
      }
      await route(req, res);
      return;
    }

    const fileName = STATIC_FILES[pathname];
    if (fileName && req.method === 'GET') {
      const filePath = path.join(ROOT, fileName);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.statusCode = 404; res.end('Not found'); return; }
        res.setHeader('Content-Type', CONTENT_TYPES[path.extname(fileName)] || 'application/octet-stream');
        res.statusCode = 200;
        res.end(data);
      });
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  } catch (e) {
    console.error('[SpotPrem] server error:', e && e.message);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json; charset=utf-8'); }
    res.end(JSON.stringify({ error: 'Server gagal' }));
  }
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  http.createServer(handler).listen(PORT, () => console.log('[SpotPrem] server jalan di port', PORT));
}

module.exports = handler;
