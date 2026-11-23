const lib = require('./_lib');

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function getQueryParam(req, name) {
  if (req.query && req.query[name] !== undefined) {
    return String(req.query[name]);
  }
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    return u.searchParams.get(name) || '';
  } catch {
    return '';
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');

  const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      code: 'YOUTUBE_API_KEY_MISSING',
      error: 'YOUTUBE_API_KEY belum diatur di Environment Variables Vercel.',
    });
  }

  const q = getQueryParam(req, 'q').trim().slice(0, 120);
  if (!q) {
    return res.status(400).json({ ok: false, error: 'Parameter q wajib diisi.' });
  }

  const maxRaw = Number.parseInt(getQueryParam(req, 'max') || '15', 10);
  const maxResults = Math.min(20, Math.max(1, Number.isFinite(maxRaw) ? maxRaw : 15));

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('videoEmbeddable', 'true');
    url.searchParams.set('regionCode', 'ID');
    url.searchParams.set('maxResults', String(maxResults));
    url.searchParams.set('q', q);
    url.searchParams.set('key', apiKey);

    const ytRes = await fetch(url.toString());
    const data = await ytRes.json().catch(() => ({}));

    if (!ytRes.ok) {
      const reason = data?.error?.errors?.[0]?.reason || '';
      const msg = data?.error?.message || `YouTube API error (${ytRes.status})`;
      const status = reason === 'quotaExceeded' ? 429 : ytRes.status;
      return res.status(status).json({
        ok: false,
        code: reason || 'YOUTUBE_API_ERROR',
        error: reason === 'quotaExceeded'
          ? 'Kuota harian YouTube API sedang penuh. Coba lagi besok atau tempel link YouTube langsung.'
          : msg,
      });
    }

    const items = (data.items || [])
      .filter((item) => item?.id?.videoId)
      .map((item) => {
        const sn = item.snippet || {};
        const thumb =
          sn.thumbnails?.medium?.url ||
          sn.thumbnails?.high?.url ||
          sn.thumbnails?.default?.url ||
          `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg`;
        return {
          videoId: item.id.videoId,
          title: decodeEntities(sn.title || 'Tanpa Judul'),
          channel: decodeEntities(sn.channelTitle || ''),
          thumbnail: thumb,
        };
      });

    // Cache 1 jam di Vercel Edge CDN untuk menghemat kuota YouTube Data API
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String((e && e.message) || e).slice(0, 160),
    });
  }
};
