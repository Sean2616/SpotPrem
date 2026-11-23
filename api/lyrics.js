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

function cleanArtistHint(raw) {
  return String(raw || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\b(vevo|official|music|records|entertainment|channel|tv)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7a3]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
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

async function fetchLrclibById(id) {
  const numId = Number.parseInt(String(id || ''), 10);
  if (!Number.isFinite(numId) || numId <= 0) return null;
  const res = await fetch(`https://lrclib.net/api/get/${numId}`, {
    headers: {
      'User-Agent': 'SpotPrem/1.0 (https://www.spotprem.me)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && typeof data === 'object' ? data : null;
}

function scoreCandidate(item, opts) {
  if (!item || typeof item !== 'object') return -9999;
  const hasSynced = typeof item.syncedLyrics === 'string' && item.syncedLyrics.trim().length > 0;
  const hasPlain = typeof item.plainLyrics === 'string' && item.plainLyrics.trim().length > 0;
  if (!hasSynced && !hasPlain) return -9999;

  let score = hasSynced ? 100 : 10;
  if (item.instrumental) score -= 80;

  const targetDuration = Number(opts && opts.targetDuration) || 0;
  const itemDuration = Number(item.duration) || 0;
  if (targetDuration > 10 && itemDuration > 10) {
    const diff = Math.abs(itemDuration - targetDuration);
    if (diff <= 1.5) score += 65;
    else if (diff <= 3.5) score += 48;
    else if (diff <= 7) score += 28;
    else if (diff <= 15) score += 8;
    else score -= Math.min(55, Math.round(diff * 1.2));
  }

  const qTokens = tokenize(opts && opts.query);
  const artistTokens = tokenize(opts && opts.artist);
  const candText = `${item.trackName || ''} ${item.artistName || ''}`.toLowerCase();
  const candTokens = new Set(tokenize(candText));

  if (qTokens.length > 0) {
    let matched = 0;
    for (const t of qTokens) {
      if (candTokens.has(t)) matched += 1;
    }
    score += Math.round((matched / qTokens.length) * 30);
  }
  if (artistTokens.length > 0) {
    let matched = 0;
    for (const t of artistTokens) {
      if (candTokens.has(t)) matched += 1;
    }
    score += Math.round((matched / artistTokens.length) * 18);
  }

  const qLower = String((opts && opts.query) || '').toLowerCase();
  const variantWords = ['remix', 'karaoke', 'sped up', 'slowed', 'nightcore', 'live', 'acoustic', 'instrumental'];
  for (const w of variantWords) {
    if (candText.includes(w) && !qLower.includes(w)) {
      score -= 18;
    }
  }

  return score;
}

function rankCandidates(items, opts) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item) => ({ item, score: scoreCandidate(item, opts) }))
    .filter((entry) => entry.score > -9000)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

function summarizeCandidates(ranked) {
  const seen = new Set();
  const out = [];
  for (const item of ranked) {
    if (!item || !item.id || typeof item.syncedLyrics !== 'string' || !item.syncedLyrics.trim()) continue;
    const key = `${item.trackName || ''}|${item.artistName || ''}|${Math.round(Number(item.duration) || 0)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id,
      trackName: item.trackName || '',
      artistName: item.artistName || '',
      albumName: item.albumName || '',
      duration: Math.round(Number(item.duration) || 0),
    });
    if (out.length >= 6) break;
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');

  const rawId = getQueryParam(req, 'id').trim();
  const rawQ = getQueryParam(req, 'q').trim().slice(0, 160);
  const rawArtist = cleanArtistHint(getQueryParam(req, 'artist').trim().slice(0, 100));
  const durRaw = Number.parseFloat(getQueryParam(req, 'duration'));
  const targetDuration = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 0;

  if (!rawQ && !rawId) {
    return res.status(400).json({ ok: false, error: 'Parameter q atau id wajib diisi.' });
  }

  const cleaned = cleanSongQuery(rawQ) || rawQ;
  const matchOpts = { targetDuration, query: cleaned, artist: rawArtist };

  try {
    let best = null;
    let candidates = [];

    if (rawId) {
      best = await fetchLrclibById(rawId);
    }

    if (!best && cleaned) {
      let items = await queryLrclib(cleaned);
      let ranked = rankCandidates(items, matchOpts);
      best = ranked[0] || null;
      candidates = summarizeCandidates(ranked);

      if (!best && cleaned.includes(' - ')) {
        const parts = cleaned.split(' - ').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          const titleOnly = parts[1].replace(/\b(feat\.?|ft\.?)\s+.*$/i, '').trim();
          if (titleOnly) {
            items = await queryLrclib(titleOnly);
            ranked = rankCandidates(items, { targetDuration, query: titleOnly, artist: rawArtist || parts[0] });
            best = ranked[0] || null;
            candidates = summarizeCandidates(ranked);
          }
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
      id: best.id || null,
      duration: Math.round(Number(best.duration) || 0),
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
      candidates,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String((e && e.message) || e).slice(0, 160),
    });
  }
};
