const path = require('path');
const lib = require('./_lib');

// Deteksi huruf Jepang (Hiragana / Katakana) dan Korea (Hangul)
const JAPANESE_KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/;
const KOREAN_HANGUL_RE = /[\uAC00-\uD7A3]/;
const LRC_LINE_RE = /^((?:\[\d{1,2}:\d{2}(?:\.\d{1,3})?\])+)\s*(.*)$/;

const KO_INITIALS = [
  'g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp',
  's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h',
];
const KO_MEDIALS = [
  'a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae',
  'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i',
];
const KO_FINALS = [
  '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'p', 'l', 'l',
  'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't',
];

function romanizeKorean(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const initial = Math.floor(idx / 588);
      const medial = Math.floor((idx % 588) / 28);
      const final = idx % 28;
      out += KO_INITIALS[initial] + KO_MEDIALS[medial] + KO_FINALS[final];
    } else {
      out += ch;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

let kuroshiroPromise = null;

async function getKuroshiro() {
  if (!kuroshiroPromise) {
    kuroshiroPromise = (async () => {
      try {
        const KuroshiroMod = require('kuroshiro');
        const Kuroshiro = KuroshiroMod.default || KuroshiroMod;
        const KuromojiMod = require('kuroshiro-analyzer-kuromoji');
        const KuromojiAnalyzer = KuromojiMod.default || KuromojiMod;

        const dictPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
        const instance = new Kuroshiro();
        await instance.init(new KuromojiAnalyzer({ dictPath }));
        return instance;
      } catch (err) {
        console.error('[Lyrics Kuroshiro Init Error]', err && err.message ? err.message : err);
        kuroshiroPromise = null;
        return null;
      }
    })();
  }
  return kuroshiroPromise;
}

async function toRomanizedLine(kuroshiro, text) {
  if (!text || !text.trim()) return '';
  const hasJa = JAPANESE_KANA_RE.test(text) || /[\u4E00-\u9FAF]/.test(text);
  const hasKo = KOREAN_HANGUL_RE.test(text);
  if (!hasJa && !hasKo) return '';

  let result = text;
  if (hasJa && kuroshiro) {
    try {
      result = await kuroshiro.convert(result, {
        to: 'romaji',
        mode: 'spaced',
        romajiSystem: 'hepburn',
      });
    } catch {
      // Lanjut ke romanisasi Korea jika ada
    }
  }
  if (hasKo) {
    result = romanizeKorean(result);
  }
  return String(result || '').replace(/\s+/g, ' ').trim();
}

async function convertLrcToRomaji(kuroshiro, lrcText) {
  if (!lrcText) return '';
  const lines = String(lrcText).split(/\r?\n/);
  const result = [];

  for (const raw of lines) {
    const m = raw.match(LRC_LINE_RE);
    if (!m) continue;
    const tags = m[1];
    const lyric = (m[2] || '').trim();
    if (!lyric) {
      result.push(tags);
      continue;
    }
    const romaji = await toRomanizedLine(kuroshiro, lyric);
    result.push(`${tags} ${romaji || ''}`.trim());
  }
  return result.join('\n');
}

async function convertPlainToRomaji(kuroshiro, plainText) {
  if (!plainText) return '';
  const lines = String(plainText).split(/\r?\n/);
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push('');
      continue;
    }
    const romaji = await toRomanizedLine(kuroshiro, trimmed);
    result.push(romaji);
  }
  return result.join('\n');
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

function cleanSongQuery(raw) {
  return String(raw || '')
    .replace(/\([^)]*(official|video|audio|lyric|lirik|mv|hd|4k|live|visualizer|version|remix|cover|karaoke|full)[^)]*\)/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s*(\||\/\/)\s*.*$/g, ' ')
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

    const syncedLyrics = best.syncedLyrics || '';
    const plainLyrics = best.plainLyrics || '';
    const hasJapanese = JAPANESE_KANA_RE.test(syncedLyrics) || JAPANESE_KANA_RE.test(plainLyrics);
    const hasKorean = KOREAN_HANGUL_RE.test(syncedLyrics) || KOREAN_HANGUL_RE.test(plainLyrics);

    let romajiSyncedLyrics = '';
    let romajiPlainLyrics = '';

    if (hasJapanese || hasKorean) {
      const kuroshiro = hasJapanese ? await getKuroshiro() : null;
      if (kuroshiro || hasKorean) {
        if (syncedLyrics) {
          romajiSyncedLyrics = await convertLrcToRomaji(kuroshiro, syncedLyrics);
        } else if (plainLyrics) {
          romajiPlainLyrics = await convertPlainToRomaji(kuroshiro, plainLyrics);
        }
      }
    }

    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      ok: true,
      found: true,
      query: cleaned,
      hasJapanese,
      hasKorean,
      trackName: best.trackName || '',
      artistName: best.artistName || '',
      albumName: best.albumName || '',
      syncedLyrics,
      plainLyrics,
      romajiSyncedLyrics,
      romajiPlainLyrics,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String((e && e.message) || e).slice(0, 160),
    });
  }
};
