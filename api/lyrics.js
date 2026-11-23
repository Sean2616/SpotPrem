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

// ============================================================
// YOUTUBE CLOSED CAPTIONS (CC) -> LRC CONVERTER
// ============================================================
const YT_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\u200B/g, '');
}

function formatLrcTimestamp(ms) {
  const safeMs = Math.max(0, Math.round(Number(ms) || 0));
  const totalSec = Math.floor(safeMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const cs = Math.floor((safeMs % 1000) / 10);
  return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

function cleanCaptionText(raw) {
  const text = decodeHtmlEntities(String(raw || ''))
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/^[\[\(]\s*(music|musik|applause|laughter|instrumental|♪|♫)+\s*[\]\)]$/i.test(text)) return '';
  if (/^[♪♫\s]+$/.test(text)) return '';
  return text;
}

function extractCaptionTracksFromHtml(html) {
  const marker = '"captionTracks":';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];
  const start = html.indexOf('[', idx + marker.length);
  if (start === -1) return [];
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(html.slice(start, i + 1));
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        }
      }
    }
  }
  return [];
}

async function fetchYouTubeCaptionTracks(videoId) {
  if (!YT_VIDEO_ID_RE.test(videoId)) return [];

  // 1. Coba ambil dari halaman watch YouTube
  try {
    const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        'User-Agent': YT_UA,
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (watchRes.ok) {
      const html = await watchRes.text();
      const tracks = extractCaptionTracksFromHtml(html);
      if (tracks.length > 0) return tracks;
    }
  } catch { /* fallback ke Innertube */ }

  // 2. Fallback: YouTube Innertube ANDROID player API
  try {
    const apiRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip',
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.29.37',
            androidSdkVersion: 34,
            hl: 'id',
            gl: 'ID',
          },
        },
      }),
    });
    if (apiRes.ok) {
      const data = await apiRes.json().catch(() => null);
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length > 0) return tracks;
    }
  } catch { /* abaikan */ }

  return [];
}

function normalizeCaptionTrack(t) {
  const code = String(t?.languageCode || '').trim();
  const isAuto = t?.kind === 'asr';
  const rawName = t?.name?.simpleText
    || (Array.isArray(t?.name?.runs) ? t.name.runs.map((r) => r.text).join('') : '')
    || code.toUpperCase();
  return {
    code,
    name: String(rawName || code).trim(),
    isAuto,
    baseUrl: String(t?.baseUrl || '').trim(),
  };
}

function pickCaptionTrack(tracks, preferredLang) {
  const list = tracks.map(normalizeCaptionTrack).filter((t) => t.code && t.baseUrl);
  if (list.length === 0) return { chosen: null, list: [] };

  if (preferredLang) {
    const pref = preferredLang.toLowerCase();
    const exact = list.find((t) => t.code.toLowerCase() === pref && !t.isAuto)
      || list.find((t) => t.code.toLowerCase() === pref);
    if (exact) return { chosen: exact, list };
  }

  // Prioritaskan caption manual (resmi dari channel MV) dibanding auto-generated (asr)
  const manual = list.filter((t) => !t.isAuto);
  const pool = manual.length > 0 ? manual : list;

  // Di antara manual, prioritaskan bahasa asli umum lagu (id, en, ja, ko) lalu fallback ke yang pertama
  const prefOrder = ['id', 'en', 'en-us', 'en-gb', 'ja', 'ko'];
  for (const lang of prefOrder) {
    const match = pool.find((t) => t.code.toLowerCase() === lang);
    if (match) return { chosen: match, list };
  }
  return { chosen: pool[0], list };
}

function captionJson3ToLrc(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const lines = [];
  let lastText = '';
  let lastMs = -1000;

  for (const ev of events) {
    if (!Array.isArray(ev?.segs) || typeof ev.tStartMs !== 'number') continue;
    const raw = ev.segs.map((s) => s?.utf8 || '').join('');
    const text = cleanCaptionText(raw);
    if (!text) continue;
    if (text === lastText && Math.abs(ev.tStartMs - lastMs) < 1500) continue;
    lines.push(`${formatLrcTimestamp(ev.tStartMs)} ${text}`);
    lastText = text;
    lastMs = ev.tStartMs;
  }
  return lines.join('\n');
}

function captionXmlToLrc(xml) {
  const lines = [];
  const re = /<text\b[^>]*start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const startSec = Number.parseFloat(m[1]);
    if (!Number.isFinite(startSec)) continue;
    const text = cleanCaptionText(m[2].replace(/<[^>]+>/g, ''));
    if (!text) continue;
    lines.push(`${formatLrcTimestamp(startSec * 1000)} ${text}`);
  }
  return lines.join('\n');
}

async function fetchYouTubeCaptionsLrc(videoId, preferredLang) {
  const rawTracks = await fetchYouTubeCaptionTracks(videoId);
  const { chosen, list } = pickCaptionTrack(rawTracks, preferredLang);
  if (!chosen) return null;

  let lrc = '';
  // 1. Coba format json3 (presisi milidetik)
  try {
    const jsonUrl = new URL(chosen.baseUrl);
    jsonUrl.searchParams.set('fmt', 'json3');
    const r = await fetch(jsonUrl.toString(), { headers: { 'User-Agent': YT_UA } });
    if (r.ok) {
      const txt = await r.text();
      if (txt && txt.trim().startsWith('{')) {
        lrc = captionJson3ToLrc(JSON.parse(txt));
      }
    }
  } catch { /* fallback ke XML */ }

  // 2. Fallback XML bawaan YouTube
  if (!lrc) {
    try {
      const r = await fetch(chosen.baseUrl, { headers: { 'User-Agent': YT_UA } });
      if (r.ok) {
        const xml = await r.text();
        lrc = captionXmlToLrc(xml);
      }
    } catch { /* abaikan */ }
  }

  if (!lrc) return null;

  const captionTracks = list.map(({ code, name, isAuto }) => ({ code, name, isAuto }));
  return {
    syncedLyrics: lrc,
    langCode: chosen.code,
    langName: chosen.name,
    isAuto: chosen.isAuto,
    captionTracks,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return lib.methodNotAllowed(res, 'GET');

  const rawId = getQueryParam(req, 'id').trim();
  const rawQ = getQueryParam(req, 'q').trim().slice(0, 160);
  const rawArtist = cleanArtistHint(getQueryParam(req, 'artist').trim().slice(0, 100));
  const rawVideoId = getQueryParam(req, 'videoId').trim();
  const videoId = YT_VIDEO_ID_RE.test(rawVideoId) ? rawVideoId : '';
  const sourceParam = getQueryParam(req, 'source').trim().toLowerCase();
  const langParam = getQueryParam(req, 'lang').trim().slice(0, 16);
  const durRaw = Number.parseFloat(getQueryParam(req, 'duration'));
  const targetDuration = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 0;

  if (!rawQ && !rawId && !videoId) {
    return res.status(400).json({ ok: false, error: 'Parameter q, id, atau videoId wajib diisi.' });
  }

  const cleaned = cleanSongQuery(rawQ) || rawQ;
  const matchOpts = { targetDuration, query: cleaned, artist: rawArtist };

  try {
    let best = null;
    let candidates = [];
    let source = 'lrclib';
    let ytMeta = null;

    // Mode khusus YouTube CC (diminta langsung oleh user via tombol CC YouTube)
    if (sourceParam === 'yt' && videoId) {
      ytMeta = await fetchYouTubeCaptionsLrc(videoId, langParam);
      if (ytMeta && ytMeta.syncedLyrics) {
        source = 'youtube';
        best = {
          id: null,
          duration: Math.round(targetDuration),
          trackName: '',
          artistName: '',
          albumName: '',
          syncedLyrics: ytMeta.syncedLyrics,
          plainLyrics: '',
        };
      }
    } else {
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

      // Auto-fallback ke YouTube CC jika LRCLIB tidak punya lirik sinkron & videoId tersedia
      const hasLrclibSynced = Boolean(best && typeof best.syncedLyrics === 'string' && best.syncedLyrics.trim());
      if (!hasLrclibSynced && videoId) {
        const ytFallback = await fetchYouTubeCaptionsLrc(videoId, langParam);
        if (ytFallback && ytFallback.syncedLyrics) {
          source = 'youtube';
          ytMeta = ytFallback;
          best = {
            id: null,
            duration: Math.round(targetDuration),
            trackName: best?.trackName || '',
            artistName: best?.artistName || '',
            albumName: best?.albumName || '',
            syncedLyrics: ytFallback.syncedLyrics,
            plainLyrics: best?.plainLyrics || '',
          };
        }
      }
    }

    if (!best) {
      res.setHeader('Cache-Control', 'public, s-maxage=300');
      return res.status(200).json({
        ok: true,
        found: false,
        source: sourceParam === 'yt' ? 'youtube' : 'lrclib',
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
      source,
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
      ytCaptionLang: ytMeta ? ytMeta.langCode : '',
      ytCaptionName: ytMeta ? ytMeta.langName : '',
      ytCaptionAuto: ytMeta ? Boolean(ytMeta.isAuto) : false,
      captionTracks: ytMeta ? ytMeta.captionTracks : [],
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String((e && e.message) || e).slice(0, 160),
    });
  }
};
