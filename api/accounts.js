const lib = require('./_lib');
module.exports = async (req, res) => {
  if (!lib.isAuthed(req)) return res.status(401).json({ error: 'Belum login' });
  if (req.method === 'GET') {
    try {
      const accounts = await lib.loadAccounts();
      return res.json({ accounts });
    } catch (e) { return lib.serverError(res, e, 'gagal memuat akun'); }
  }
  if (req.method === 'PUT') {
    const cleaned = lib.cleanAccounts(lib.bodyOf(req) && lib.bodyOf(req).accounts);
    if (!cleaned) return res.status(400).json({ error: 'Format data akun tidak valid' });
    try {
      await lib.saveAccounts(cleaned);
    } catch (e) { return lib.serverError(res, e, 'gagal menyimpan'); }
    return res.json({ ok: true, count: cleaned.length, active: cleaned.filter(a => a.available).length });
  }
  return lib.methodNotAllowed(res, 'GET, PUT');
};
