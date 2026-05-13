// ═══════════════════════════════════════════════════════════════════════
//  TUTOR IA — resourceFallbacks.js
//  Cascada de búsqueda de recursos cuando Gemini grounding no devuelve
//  suficientes resultados (fix Bug 3).
//
//  Plan A: Gemini grounding (en server.js, externo a este archivo)
//  Plan B: paralelo
//    B1) YouTube Data API v3  → videos educativos de apoyo, limitados por nivel
//    B2) Google CSE restringido → PDFs directos en dominios trusted
//  Plan C: pool curado (curatedResources.json)
//
//  Cache 24h en memoria por (query|grado|materia|nivel) para no quemar cuotas.
// ═══════════════════════════════════════════════════════════════════════

import {
    limpiarTrackingUrl,
    esYoutubeVideoUrl,
    extraerYoutubeId,
    esFuenteProhibida,
    esPdfUrl,
    puntuarRecurso,
    dominioBase
} from './resourceQuality.js';

const YOUTUBE_KEY    = process.env.YOUTUBE_API_KEY;
const GOOGLE_CSE_ID  = process.env.GOOGLE_CSE_ID;
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_KEY;
const NIVELES_REFERENCIA = ['Secundaria', 'Preparatoria', 'Universidad'];
const META_RECURSOS_TAREA = 4;
const META_PDFS = 2;
const META_VIDEOS = 1;
const MAX_PDFS_RESULTADO = 6;
const MAX_VIDEOS_RESULTADO = 2;

const providerDiagnostics = {
    youtube: {
        configured: !!YOUTUBE_KEY,
        lastTriedAt: null,
        lastOkAt: null,
        lastStatus: null,
        lastError: null,
        probableCause: YOUTUBE_KEY ? null : 'not_configured'
    },
    googleCSE: {
        configured: !!(GOOGLE_CSE_KEY && GOOGLE_CSE_ID),
        optional: true,
        lastTriedAt: null,
        lastOkAt: null,
        lastStatus: null,
        lastError: null,
        probableCause: (GOOGLE_CSE_KEY && GOOGLE_CSE_ID) ? null : 'not_configured'
    }
};

let lastCascade = {
    lastRunAt: null,
    total: 0,
    taskReadyCount: 0,
    pdfCount: 0,
    sourcesUsed: [],
    lowConfidence: null
};

function cloneJSON(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeSearchText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizarNivelReferencia(value) {
    const norm = normalizeSearchText(value);
    if (/secundaria|secundario/.test(norm)) return 'Secundaria';
    if (/prepa|preparatoria|bachillerato|semestre/.test(norm)) return 'Preparatoria';
    if (/universidad|universitario|licenciatura|superior/.test(norm)) return 'Universidad';
    return '';
}

function complejidadPorNivel(value) {
    const nivel = normalizarNivelReferencia(value);
    if (nivel === 'Secundaria') return 'introductorio';
    if (nivel === 'Universidad') return 'avanzado';
    return 'intermedio';
}

function sanitizeProviderError(value) {
    return String(value || '')
        .replace(/key=[^&\s]+/gi, 'key=[redacted]')
        .replace(/AIza[0-9A-Za-z_-]+/g, '[redacted]')
        .slice(0, 220);
}

function classifyProviderIssue(provider, status, message) {
    const msg = String(message || '').toLowerCase();
    if (provider === 'googleCSE' && /closed|not available|not have access|permission|forbidden/.test(msg)) {
        return 'closed_or_restricted';
    }
    if (status === 403 || status === 429 || /quota|restricted|rate|forbidden|permission|limit/.test(msg)) {
        return 'quota_or_restriction';
    }
    if (status === 400 || /cx|search engine|api key|invalid/.test(msg)) {
        return 'invalid_configuration';
    }
    if (/abort|timeout|timed out/.test(msg)) return 'timeout';
    if (status && status >= 500) return 'provider_error';
    return 'request_failed';
}

async function providerErrorMessage(res) {
    let message = `HTTP ${res.status}`;
    try {
        const json = await res.json();
        message = json?.error?.message || json?.message || message;
    } catch {}
    return message;
}

function markProviderAttempt(provider) {
    providerDiagnostics[provider].lastTriedAt = new Date().toISOString();
    providerDiagnostics[provider].lastStatus = null;
    providerDiagnostics[provider].lastError = null;
    providerDiagnostics[provider].probableCause = null;
}

function markProviderOk(provider, status) {
    providerDiagnostics[provider].lastOkAt = new Date().toISOString();
    providerDiagnostics[provider].lastStatus = status;
    providerDiagnostics[provider].lastError = null;
    providerDiagnostics[provider].probableCause = null;
}

function markProviderFailure(provider, status, error) {
    const message = sanitizeProviderError(error);
    providerDiagnostics[provider].lastStatus = status ?? null;
    providerDiagnostics[provider].lastError = status ? `HTTP ${status}: ${message}` : message;
    providerDiagnostics[provider].probableCause = classifyProviderIssue(provider, status, message);
}

function recordCascade(resultados) {
    const sources = [...new Set(resultados.map(r => r?.fuenteOrigen || 'desconocido'))];
    const taskReady = resultados.filter(esRecursoParaTarea);
    const pdfs = taskReady.filter(esRecursoPdf);
    const videos = resultados.filter(esRecursoVideo);
    lastCascade = {
        lastRunAt: new Date().toISOString(),
        total: resultados.length,
        taskReadyCount: taskReady.length,
        pdfCount: pdfs.length,
        videoCount: videos.length,
        sourcesUsed: sources,
        lowConfidence: taskReady.length < 3 || pdfs.length === 0
    };
}

function esRecursoVideo(r) {
    return !!(r?.esVideo || r?.youtubeId || r?.videoId || r?.tipo === 'Video' || esYoutubeVideoUrl(r?.url || ''));
}

function esRecursoParaTarea(r) {
    return esRecursoPdf(r);
}

function esRecursoPdf(r) {
    return !!(r?.url && !esRecursoVideo(r) && esPdfUrl(r.url || ''));
}

function tieneFuentesParaTarea(lista) {
    return lista.some(esRecursoParaTarea);
}

function tienePdf(lista) {
    return lista.some(esRecursoPdf);
}

function countRecursosParaTarea(lista) {
    return lista.filter(esRecursoParaTarea).length;
}

function countPdfs(lista) {
    return lista.filter(esRecursoPdf).length;
}

function ordenarPdfFirst(lista) {
    const unicos = dedupAndRank(lista);
    const pdfs = unicos
        .filter(esRecursoPdf)
        .map(r => ({ ...r, tipo: 'PDF', esVideo: false }))
        .slice(0, MAX_PDFS_RESULTADO);
    const videos = unicos
        .filter(esRecursoVideo)
        .map(r => normalizarVideoRecurso(r))
        .slice(0, MAX_VIDEOS_RESULTADO);
    return [...pdfs, ...videos];
}

function normalizarVideoRecurso(r, nivelFallback = '') {
    const nivel = normalizarNivelReferencia(r?.nivel || r?.nivelReferencia || nivelFallback) || 'Preparatoria';
    const youtubeId = r?.youtubeId || r?.videoId || extraerYoutubeId(r?.url || '');
    return {
        ...r,
        tipo: 'Video',
        esVideo: true,
        youtubeId,
        videoId: youtubeId,
        nivel,
        complejidad: r?.complejidad || complejidadPorNivel(nivel),
        fuente: r?.fuente || r?.canal || 'YouTube'
    };
}

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
export async function fallbackYoutube(query, grado = '', maxResults = 4, materia = '', nivelReferencia = '') {
    if (!YOUTUBE_KEY) return [];
    const nivel = normalizarNivelReferencia(nivelReferencia || grado) || grado || 'Preparatoria';
    const complejidad = complejidadPorNivel(nivel);
    const materiaNorm = normalizeSearchText(materia);
    const cacheKey = `yt:${normalizeSearchText(query)}|${normalizeSearchText(nivel)}|${materiaNorm}|${maxResults}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    const q = encodeURIComponent(`${query} ${materia || ''} ${nivel} ${complejidad} español educativo clase explicación`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=${maxResults * 3}` +
                `&q=${q}&type=video&relevanceLanguage=es&videoDuration=medium&safeSearch=strict&key=${YOUTUBE_KEY}`;

    let timer;
    try {
        markProviderAttempt('youtube');
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
            const msg = await providerErrorMessage(res);
            markProviderFailure('youtube', res.status, msg);
            return [];
        }
        markProviderOk('youtube', res.status);
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
                    videoId: it.id.videoId,
                    descripcion: (it.snippet?.description || '').slice(0, 200),
                    canal: it.snippet?.channelTitle || '',
                    fuente: it.snippet?.channelTitle || 'YouTube',
                    tipo: 'Video',
                    esVideo: true,
                    nivel,
                    complejidad,
                    score: boosted ? 80 : 60,
                    fuenteOrigen: 'youtube'
                };
            })
            .slice(0, maxResults);

        cacheSet(cacheKey, recursos);
        return recursos;
    } catch (e) {
        markProviderFailure('youtube', null, e.message);
        console.warn('⚠️  fallbackYoutube error:', e.message);
        return [];
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Plan B2 — Google Custom Search Engine restringido
//  El CSE debe estar configurado en https://programmablesearchengine.google.com/
//  con la lista de dominios trusted y ok del resourceQuality.js
// ─────────────────────────────────────────────────────────────────────────
export async function fallbackGoogleCSE(query, grado = '', maxResults = 6, materia = '', nivelReferencia = '') {
    if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_ID) return [];
    const nivel = normalizarNivelReferencia(nivelReferencia || grado) || grado || 'Preparatoria';
    const materiaNorm = normalizeSearchText(materia);
    const cacheKey = `cse:${normalizeSearchText(query)}|${normalizeSearchText(nivel)}|${materiaNorm}|${maxResults}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    const q = encodeURIComponent(`${query} ${materia || ''} ${nivel}`.trim() + ' filetype:pdf guía material docente material educativo explicación educativa');
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_ID}` +
                `&q=${q}&num=${Math.min(maxResults, 10)}&lr=lang_es&safe=active`;

    let timer;
    try {
        markProviderAttempt('googleCSE');
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
            const msg = await providerErrorMessage(res);
            markProviderFailure('googleCSE', res.status, msg);
            return [];
        }
        markProviderOk('googleCSE', res.status);
        const json = await res.json();
        const items = Array.isArray(json.items) ? json.items : [];

        const recursos = items
            .map(it => {
                const cleaned = limpiarTrackingUrl(it.link);
                if (!esPdfUrl(cleaned, it.mime || '')) return null;
                const score = puntuarRecurso(cleaned);
                if (score < 50) return null;
                return {
                    titulo: it.title || 'Recurso educativo',
                    url: cleaned,
                    descripcion: (it.snippet || '').slice(0, 250),
                    fuente: dominioBase(cleaned),
                    tipo: 'PDF',
                    score,
                    fuenteOrigen: 'cse'
                };
            })
            .filter(Boolean)
            .slice(0, maxResults);

        cacheSet(cacheKey, recursos);
        return recursos;
    } catch (e) {
        markProviderFailure('googleCSE', null, e.message);
        console.warn('⚠️  fallbackGoogleCSE error:', e.message);
        return [];
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ─────────────────────────────────────────────────────────────────────────
//  Plan C — Pool curado (last resort, garantiza nunca devolver vacío)
// ─────────────────────────────────────────────────────────────────────────
export async function fallbackPoolCurado(query = '', grado = '', materia = '') {
    const pool = await loadCuratedPool();
    const queryLower = normalizeSearchText(query);
    const gradoLower = normalizeSearchText(grado);
    const materiaLower = normalizeSearchText(materia);

    // Estructura de curatedResources.json:
    // { "<materia>": [ { titulo, url, tipo, grados:[], temas:[], descripcion } ] }
    const candidatos = [];
    const pdfsGlobales = [];
    for (const [keyMat, lista] of Object.entries(pool)) {
        if (!Array.isArray(lista)) continue;
        const keyMatNorm = normalizeSearchText(keyMat);
        const materiaMatch = materiaLower && (keyMatNorm.includes(materiaLower) || materiaLower.includes(keyMatNorm));
        for (const r of lista) {
            if (esFuenteProhibida(r.url || '')) continue;
            if (!esPdfUrl(r.url || '')) continue;
            const recursoPdf = { ...r, tipo: 'PDF', score: r.score || 75, fuenteOrigen: 'curado' };
            pdfsGlobales.push(recursoPdf);
            const temasMatch = (r.temas || []).some(t => {
                const temaNorm = normalizeSearchText(t);
                return queryLower.includes(temaNorm) || temaNorm.includes(queryLower);
            });
            const gradoMatch = !gradoLower || (r.grados || []).some(g => {
                const gradoNorm = normalizeSearchText(g);
                return gradoLower.includes(gradoNorm) || gradoNorm.includes(gradoLower);
            });
            if ((materiaMatch || temasMatch) && gradoMatch) {
                candidatos.push(recursoPdf);
            }
        }
    }
    // Si nada matchea, devolver PDFs directos del pool default; si tampoco hay,
    // usar PDFs directos globales para garantizar fuentes finales antes que páginas.
    if (candidatos.length === 0) {
        const def = (pool.default || [])
            .filter(r => !esFuenteProhibida(r.url || '') && esPdfUrl(r.url || ''))
            .map(r => ({ ...r, tipo: 'PDF', score: r.score || 70, fuenteOrigen: 'curado' }));
        return (def.length ? def : pdfsGlobales).slice(0, 4);
    }
    return candidatos.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────
//  Cascada principal — combina los tres planes
// ─────────────────────────────────────────────────────────────────────────
export async function obtenerRecursosConCascada({ tema, grado = '', materia = '', nivelReferencia = '', recursosIA = [] }) {
    const nivelEfectivo = normalizarNivelReferencia(nivelReferencia || grado) || grado || '';
    // recursosIA = lo que ya devolvió Gemini (Plan A) — opcional
    const yaTeniamos = (Array.isArray(recursosIA) ? recursosIA : [])
        .map(r => ({ ...r, score: r.score || puntuarRecurso(r.url || '') || 50, fuenteOrigen: r.fuenteOrigen || 'gemini' }))
        .filter(r => r.url && !esFuenteProhibida(r.url) && (esRecursoPdf(r) || esRecursoVideo(r)))
        .map(r => esRecursoVideo(r)
            ? normalizarVideoRecurso(r, nivelEfectivo)
            : { ...r, tipo: 'PDF', esVideo: false, nivel: normalizarNivelReferencia(r.nivel || nivelEfectivo) || nivelEfectivo || r.nivel }
        );

    let resultados = [...yaTeniamos];

    // Si Plan A ya tiene suficientes PDFs directos y al menos un video, devolvemos directo.
    if (
        countRecursosParaTarea(resultados) >= META_RECURSOS_TAREA &&
        countPdfs(resultados) >= META_PDFS &&
        resultados.filter(esRecursoVideo).length >= META_VIDEOS
    ) {
        const ranked = ordenarPdfFirst(resultados);
        recordCascade(ranked);
        return ranked;
    }

    // Disparar Plan B en paralelo: YouTube aporta videos; CSE aporta PDFs directos.
    const [yt, cse] = await Promise.allSettled([
        fallbackYoutube(tema, nivelEfectivo, MAX_VIDEOS_RESULTADO, materia, nivelEfectivo),
        fallbackGoogleCSE(tema, nivelEfectivo, 6, materia, nivelEfectivo)
    ]);
    if (yt.status === 'fulfilled') resultados = resultados.concat(yt.value);
    if (cse.status === 'fulfilled') resultados = resultados.concat(cse.value);

    // Si aún no llegamos a suficientes PDFs directos, traemos pool curado.
    // Esto evita que YouTube o páginas generales "llenen" la búsqueda.
    if (countRecursosParaTarea(resultados) < META_RECURSOS_TAREA || countPdfs(resultados) < META_PDFS || !tieneFuentesParaTarea(resultados) || !tienePdf(resultados)) {
        const curado = await fallbackPoolCurado(tema, nivelEfectivo, materia);
        resultados = resultados.concat(curado);
    }

    const ranked = ordenarPdfFirst(resultados);
    recordCascade(ranked);
    return ranked;
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
        },
        youtube: cloneJSON(providerDiagnostics.youtube),
        googleCSE: cloneJSON(providerDiagnostics.googleCSE),
        lastCascade: cloneJSON(lastCascade)
    };
}
