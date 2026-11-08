const lib = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');
  try {
    const activity = await lib.loadActivity();
    const stats = {};
    for (const e of activity) {
      if (!e || !e.email) continue;
      const st = stats[e.email] || (stats[e.email] = { copies: 0, views: 0, last: null, lastView: null });
      if (e.kind === 'reveal') { st.views += 1; if (!st.lastView || e.t > st.lastView) st.lastView = e.t; }
      else { st.copies += 1; if (!st.last || e.t > st.last) st.last = e.t; }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ stats });
  } catch (e) { return lib.serverError(res, e, 'gagal memuat copystats'); }
};
