const lib = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');
  try {
    const [accounts, activity] = await Promise.all([lib.loadAccounts(), lib.loadActivity()]);
    return res.json({ ok: true, accounts: accounts.length, activity: activity.length, storage: 'firebase', runtime: 'vercel' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 140), storage: 'firebase', runtime: 'vercel' });
  }
};
