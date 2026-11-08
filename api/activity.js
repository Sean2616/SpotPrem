const lib = require('./_lib');
module.exports = async (req, res) => {
  if (!lib.isAuthed(req)) return res.status(401).json({ error: 'Belum login' });
  if (req.method === 'GET') {
    try {
      const activity = await lib.loadActivity();
      return res.json({ total: activity.length, activity: activity.slice(-200).reverse() });
    } catch (e) { return lib.serverError(res, e, 'gagal memuat aktivitas'); }
  }
  if (req.method === 'DELETE') {
    try {
      await lib.saveActivity([]);
    } catch (e) { return res.status(500).json({ error: 'Gagal membersihkan: ' + e.message.slice(0, 120) }); }
    return res.json({ ok: true });
  }
  return lib.methodNotAllowed(res, 'GET, DELETE');
};
