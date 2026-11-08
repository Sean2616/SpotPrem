// ============================================================
// SpotPrem — entrypoint tunggal (server.js) untuk mode Node
// Service di Vercel. Build log Vercel 2026-11-08 meminta ini
// persis: 'No entrypoint found ... Set package.json "main" to
// a server file, or add one of: ... server.js ...'
//
// File ini TIDAK memakai Express / dependensi apa pun — hanya
// Node bawaan. Tugasnya:
//   - menyajikan file statis (index/admin/player.html)
//   - meneruskan /api/* dan /data-akun.js ke handler yang sama
//     dengan fungsi serverless di folder api/
// Bila project Vercel berjalan dalam mode statis + fungsi
// (Framework Preset "Other"), file ini tidak dipakai sama
// sekali dan fungsi di api/ yang bekerja — dua-duanya aman.
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

/* Bungkus res Node mentah agar cocok dengan gaya handler
   serverless: res.status().json(), res.send(), res.setHeader() */
function wrapRes(res) {
  res.status = n => { res.statusCode = n; return res; };
  res.json = obj => {
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = text => { res.end(text); return res; };
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

const server = http.createServer(async (req, res) => {
  wrapRes(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    const handler = ROUTES[pathname];
    if (handler) {
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        req.body = await readBody(req);
      }
      await handler(req, res);
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('[SpotPrem] server jalan di port', PORT));

module.exports = server;
