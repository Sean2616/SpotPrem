const lib = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.methodNotAllowed(res, 'POST');
  res.setHeader('Set-Cookie', lib.clearCookieHeader());
  return res.json({ ok: true });
};
