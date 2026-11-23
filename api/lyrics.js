const lib = require('./_lib');

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

function cleanSongQuery(raw) {
  return String(raw || '')
    // Hapus teks dalam kurung/siku yang umum di judul YouTube
    .replace(/\([^)]*(official|video|audio|lyric|lirik|mv|hd|4k|live|visualizer|version|remix|cover|karaoke|full|hd)[^)]*\)/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    // Hapus akhiran setelah "|" atau "//"
    .replace(/\s*(\||\/\/)\s*.*$/g, ' ')
    // Hapus kata noise umum
    .replace(/\b(official\s+music\s+video|official\s+video|official\s+audio|official\s+lyric\s+video|music\s+video|lyric\s+video|lirik\s+lagu|full\s+album|audio\s+resmi)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function queryLrclib(q) {
  const url = new URL('https://lrclib.net/api/search');
  url.searchParams.set('q', q);

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'SpotPrem/1.0 (https://www.spotprem.me)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

function pickBestMatch(items) {
  if (!items || items.length === 0) return null;
  const withSynced = items.find((i) => i && typeof i.syncedLyrics === 'string' && i.syncedLyrics.trim());
  if (withSynced) return withSynced;
  const withPlain = items.find((i) => i && typeof i.plainLyrics === 'string' && i.plainLyrics.trim());
  return withPlain || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');

  const rawQ = getQueryParam(req, 'q').trim().slice(0, 160);
  if (!rawQ) {
    return res.status(400).json({ ok: false, error: 'Parameter q wajib diisi.' });
  }

  const cleaned = cleanSongQuery(rawQ) || rawQ;

  try {
    let items = await queryLrclib(cleaned);
    let best = pickBestMatch(items);

    // Fallback: jika format "Artis - Judul", coba cari judulnya saja
    if (!best && cleaned.includes(' - ')) {
      const parts = cleaned.split(' - ').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const titleOnly = parts[1].replace(/\b(feat\.?|ft\.?)\s+.*$/i, '').trim();
        if (titleOnly) {
          items = await queryLrclib(titleOnly);
          best = pickBestMatch(items);
        }
      }
    }

    if (!best) {
      res.setHeader('Cache-Control', 'public, s-maxage=300');
      return res.status(200).json({
        ok: true,
        found: false,
        query: cleaned,
      });
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      ok: true,
      found: true,
      query: cleaned,
      trackName: best.trackName || '',
      artistName: best.artistName || '',
      albumName: best.albumName || '',
      syncedLyrics: best.syncedLyrics || '',
      plainLyrics: best.plainLyrics || '',
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String((e && e.message) || e).slice(0, 160),
    });
  }
};
