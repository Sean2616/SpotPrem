const lib = require('./_lib');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return lib.methodNotAllowed(res, 'POST');
  const ip = lib.clientIp(req);
  if (lib.loginLocked(ip)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan salah. Coba lagi dalam 5 menit.' });
  }
  const body = lib.bodyOf(req);
  if (!lib.passwordMatches(body && body.password)) {
    lib.noteLoginFail(ip);
    return res.status(401).json({ error: 'Password salah' });
  }
  lib.clearLoginFails(ip);
  res.setHeader('Set-Cookie', lib.sessionCookieHeader(req));
  return res.json({ ok: true });
};
