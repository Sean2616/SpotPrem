const lib = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.methodNotAllowed(res, 'POST');
  const ip = lib.clientIp(req);
  if (lib.trackRateLimited(ip)) return res.status(204).end();
  const b = lib.bodyOf(req) || {};
  const kind = ['email', 'password', 'both', 'reveal'].includes(b.kind) ? b.kind : null;
  if (!kind) return res.status(400).json({ error: 'kind tidak valid' });
  try {
    const activity = await lib.loadActivity();
    activity.push({
      t: new Date().toISOString(),
      email: String(b.email || '').slice(0, 200),
      plan: String(b.plan || '').slice(0, 120),
      kind,
      ip: ip.slice(0, 64),
      ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 140),
    });
    await lib.saveActivity(activity);
  } catch (e) { console.error('[SpotPrem] gagal menyimpan aktivitas:', e.message); }
  return res.status(204).end();
};
