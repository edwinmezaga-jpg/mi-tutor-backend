// ═══════════════════════════════════════════════════════════════════════
//  TUTOR IA — resourceFallbacks.js
//  Cascada de búsqueda de recursos cuando Gemini grounding no devuelve
//  suficientes resultados (fix Bug 3).
//
//  Plan A: Gemini grounding (en server.js, externo a este archivo)
//  Plan B: paralelo
//    B1) YouTube Data API v3  → videos en español filtrados
//    B2) Google CSE restringido → PDFs y artículos en dominios trusted
//  Plan C: pool curado (curatedResources.json)
//
//  Cache 24h en memoria por (query|grado) para no quemar cuotas.
// ═══════════════════════════════════════════════════════════════════════

import {
    limpiarTrackingUrl,
    esYoutubeVideoUrl,
    extraerYoutubeId,
    esFuenteProhibida,
    esPdfUrl,
    puntuarRecurso,
    tipoArticuloEducativo,
    dominioBase
} from './resourceQuality.js';

const YOUTUBE_KEY    = process.env.YOUTUBE_API_KEY;
const GOOGLE_CSE_ID  = process.env.GOOGLE_CSE_ID;
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_KEY;

// Canales NO educativos a bloquear (música, gaming, vlogs random)
const YOUTUBE_CHANNEL_BLACKLIST = new Set([
    'UCq-Fj5jknLsUf-MWSy4_brA', // T-Series (música)
    'UC0C-w0YjGpqDXGB8IHb662A', // PewDiePie
    'UCpEhnqL0y41EpW2TvWAHD7Q', // SET India
]);

// Canales educativos a priorizar (boost de score)
const YOUTUBE_CHANNEL_BOOST = new Set([
    'UCX6b17PVsYBQ0ip5gyeme-Q', // CrashCourse
    'UC7_gcs09iThXybpVgjHZ_7g', // PBS Space Time
    'UCsXVk37bltHxD1rDPwtNM8Q', // Kurzgesagt
    'UCYO_jab_esuFRV4b17AJtAw', // 3Blue1Brown
    'UCrFOEQrwlKKhCXbfvnp4Wgw', // BBC Earth
]);

// ── Cache simple in-memory con TTL 24h
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // key → { ts, data }

function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
    return e.data;
}
function cacheSet(key, data) {
    cache.set(key, { ts: Date.now(), data });
    // Garbage collect: si la cache crece más de 500 entradas, limpia las más viejas
    if (cache.size > 500) {
        const sorted = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < 100; i++) cache.delete(sorted[i][0]);
    }
}

// ── Pool curado (~ pequeño en este archivo; el grueso vive en JSON)
let curatedPool = null;
async function loadCuratedPool() {
    if (curatedPool) return curatedPool;
    try {
        const fs = await import('fs/promises');
        const url = await import('url');
        const path = await import('path');
        const dir = path.dirname(url.fileURLToPath(import.meta.url));
        const raw = await fs.readFile(path.join(dir, 'curatedResources.json'), 'utf8');
        curatedPool = JSON.parse(raw);
    } catch (e) {
        console.warn('⚠️  curatedResources.json no encontrado, pool curado vacío');
        curatedPool = { default: [] };
    }
    return curatedPool;
}

// ─────────────────────────────────────────────────────────────────────────
//  Plan B1 — YouTube Data API v3
// ─────────────────────────────────────────────────────────────────────────
export async function fallbackYoutube(query, grado = '', maxResults = 4) {
    if (!YOUTUBE_KEY) return [];
    const cacheKey = `yt:${query}|${grado}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    const q = encodeURIComponent(`${query} ${grado || 'preparatoria'} español educativo explicación`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=${maxResults * 3}` +
                `&q=${q}&type=video&relevanceLanguage=es&videoDuration=medium&safeSearch=strict&key=${YOUTUBE_KEY}`;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return [];
        const json = await res.json();
        const items = Array.isArray(json.items) ? json.items : [];

        const recursos = items
            .filter(it => it.id?.videoId && !YOUTUBE_CHANNEL_BLACKLIST.has(it.snippet?.channelId))
            .map(it => {
                const videoUrl = `https://www.youtube.com/watch?v=${it.id.videoId}`;
                const boosted = YOUTUBE_CHANNEL_BOOST.has(it.snippet?.channelId);
                return {
                    titulo: it.snippet?.title || 'Video educativo',
                    url: videoUrl,
                    youtubeId: it.id.videoId,
                    descripcion: (it.snippet?.description || '').slice(0, 200),
                    canal: it.snippet?.channelTitle || '',
                    score: boosted ? 80 : 60,
                    fuenteOrigen: 'youtube'
                };
            })
            .slice(0, maxResults);

        cacheSet(cacheKey, recursos);
        return recursos;
    } catch (e) {
        console.warn('⚠️  fallbackYoutube error:', e.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Plan B2 — Google Custom Search Engine restringido
//  El CSE debe estar configurado en https://programmablesearchengine.google.com/
//  con la lista de dominios trusted y ok del resourceQuality.js
// ─────────────────────────────────────────────────────────────────────────
export async function fallbackGoogleCSE(query, grado = '', maxResults = 5) {
    if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_ID) return [];
    const cacheKey = `cse:${query}|${grado}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    const q = encodeURIComponent(`${query} ${grado || ''}`.trim() + ' explicación educativa');
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_ID}` +
                `&q=${q}&num=${Math.min(maxResults, 10)}&lr=lang_es&safe=active`;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return [];
        const json = await res.json();
        const items = Array.isArray(json.items) ? json.items : [];

        const recursos = items
            .map(it => {
                const cleaned = limpiarTrackingUrl(it.link);
                const score = puntuarRecurso(cleaned);
                if (score < 50) return null;
                return {
                    titulo: it.title || 'Recurso educativo',
                    url: cleaned,
                    descripcion: (it.snippet || '').slice(0, 250),
                    fuente: dominioBase(cleaned),
                    tipo: tipoArticuloEducativo(cleaned, it.mime || ''),
                    score,
                    fuenteOrigen: 'cse'
                };
            })
            .filter(Boolean)
            .slice(0, maxResults);

        cacheSet(cacheKey, recursos);
        return recursos;
    } catch (e) {
        console.warn('⚠️  fallbackGoogleCSE error:', e.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Plan C — Pool curado (last resort, garantiza nunca devolver vacío)
// ─────────────────────────────────────────────────────────────────────────
export async function fallbackPoolCurado(query = '', grado = '', materia = '') {
    const pool = await loadCuratedPool();
    const queryLower = (query || '').toLowerCase();
    const gradoLower = (grado || '').toLowerCase();
    const materiaLower = (materia || '').toLowerCase();

    // Estructura de curatedResources.json:
    // { "<materia>": [ { titulo, url, tipo, grados:[], temas:[], descripcion } ] }
    const candidatos = [];
    for (const [keyMat, lista] of Object.entries(pool)) {
        if (!Array.isArray(lista)) continue;
        const materiaMatch = materiaLower && keyMat.toLowerCase().includes(materiaLower);
        for (const r of lista) {
            const temasMatch = (r.temas || []).some(t => queryLower.includes(t.toLowerCase()) || t.toLowerCase().includes(queryLower));
            const gradoMatch = !gradoLower || (r.grados || []).some(g => gradoLower.includes(g.toLowerCase()) || g.toLowerCase().includes(gradoLower));
            if ((materiaMatch || temasMatch) && gradoMatch) {
                candidatos.push({ ...r, score: r.score || 75, fuenteOrigen: 'curado' });
            }
        }
    }
    // Si nada matchea, devolver primeros 3 del pool default
    if (candidatos.length === 0) {
        const def = pool.default || [];
        return def.slice(0, 3).map(r => ({ ...r, score: r.score || 70, fuenteOrigen: 'curado' }));
    }
    return candidatos.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────
//  Cascada principal — combina los tres planes
// ─────────────────────────────────────────────────────────────────────────
export async function obtenerRecursosConCascada({ tema, grado = '', materia = '', recursosIA = [] }) {
    // recursosIA = lo que ya devolvió Gemini (Plan A) — opcional
    const yaTeniamos = (Array.isArray(recursosIA) ? recursosIA : [])
        .map(r => ({ ...r, score: r.score || puntuarRecurso(r.url || '') || 50, fuenteOrigen: r.fuenteOrigen || 'gemini' }))
        .filter(r => r.url && !esFuenteProhibida(r.url));

    let resultados = [...yaTeniamos];

    // Si Plan A ya tiene suficiente, devolvemos directo
    if (resultados.length >= 4) {
        return dedupAndRank(resultados);
    }

    // Disparar Plan B en paralelo
    const [yt, cse] = await Promise.allSettled([
        fallbackYoutube(tema, grado),
        fallbackGoogleCSE(tema, grado)
    ]);
    if (yt.status === 'fulfilled') resultados = resultados.concat(yt.value);
    if (cse.status === 'fulfilled') resultados = resultados.concat(cse.value);

    // Si aún no llegamos a 3, traemos pool curado
    if (resultados.length < 3) {
        const curado = await fallbackPoolCurado(tema, grado, materia);
        resultados = resultados.concat(curado);
    }

    return dedupAndRank(resultados);
}

function dedupAndRank(lista) {
    const seen = new Map();
    for (const r of lista) {
        if (!r || !r.url) continue;
        const key = (r.youtubeId && `yt:${r.youtubeId}`) || limpiarTrackingUrl(r.url).toLowerCase();
        const existing = seen.get(key);
        if (!existing || (r.score || 0) > (existing.score || 0)) {
            seen.set(key, r);
        }
    }
    const unicos = [...seen.values()];
    unicos.sort((a, b) => (b.score || 0) - (a.score || 0));
    return unicos;
}

// ─────────────────────────────────────────────────────────────────────────
//  Telemetría exportable
// ─────────────────────────────────────────────────────────────────────────
export function getFallbackTelemetry() {
    return {
        cacheSize: cache.size,
        config: {
            youtubeKeySet: !!YOUTUBE_KEY,
            googleCSESet: !!(GOOGLE_CSE_KEY && GOOGLE_CSE_ID)
        }
    };
}
