// Disajikan sebagai /data-akun.js lewat rewrite di vercel.json.
// Bentuknya sama persis seperti versi Render: const accounts = [...]
const lib = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');
  try {
    const accounts = await lib.loadAccounts();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send('const accounts = ' + JSON.stringify(accounts) + ';\n');
  } catch (e) { return lib.serverError(res, e, 'gagal memuat data-akun'); }
};
