// ═══════════════════════════════════════════════════════════════════════
//  TUTOR IA — resourceQuality.js
//  v2.0.0.6 — añade scoring 0–100 y tier OK_DOMAINS para mayor cobertura
//             cuando Gemini grounding devuelve poco (fix Bug 3).
//  Cambios:
//   - Khan Academy sale de BANNED (es educativo confiable)
//   - Se añade EDUCATIONAL_OK_DOMAINS (segunda capa: BBC Bitesize, NatGeo
//     Education, openstax, archive.org/details, TED-Ed, Coursera, etc.)
//   - puntuarRecurso(url, ctx) → 0–100 para ranking, no filtro binario
//   - esUrlEducativaFinal(url) sigue funcionando (compat) = score >= 50
// ═══════════════════════════════════════════════════════════════════════

const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_reader', 'utm_viz_id', 'utm_pubreferrer',
    'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid', 'si',
    'feature', 'ab_channel', 'pp'
]);

// Bloqueados: Wikipedia se mantiene fuera (queremos fuentes primarias).
// Khan Academy SE QUITA — es educativo confiable (videos + ejercicios).
const BANNED_DOMAINS = [
    'wikipedia.org',
    'wikimedia.org',
    'wikiwand.com',
    'google.com',
    'google.com.mx'
];

// Tier 1 — máxima confianza académica (universidades, gobierno, organismos)
const TRUSTED_EDUCATIONAL_DOMAINS = [
    'gob.mx',
    'gov',
    'gov.mx',
    'edu',
    'edu.mx',
    'unam.mx',
    'ipn.mx',
    'sep.gob.mx',
    'conacyt.mx',
    'conahcyt.mx',
    'uam.mx',
    'colmex.mx',
    'cide.edu',
    'tec.mx',
    'udg.mx',
    'uanl.mx',
    'buap.mx',
    'inegi.org.mx',
    'scielo.org',
    'scielo.org.mx',
    'redalyc.org',
    'dialnet.unirioja.es',
    'repositorio.cepal.org',
    'unesco.org',
    'who.int',
    'paho.org',
    'nasa.gov',
    'noaa.gov',
    'nih.gov',
    'mit.edu',
    'ocw.mit.edu',
    'openstax.org',
    'oercommons.org',
    'worldbank.org',
    'cepal.org'
];

// Tier 2 — educativos confiables aunque no sean .edu/.gov (curados)
const EDUCATIONAL_OK_DOMAINS = [
    'khanacademy.org',           // Khan Academy
    'es.khanacademy.org',
    'bbc.co.uk',                  // BBC Bitesize y educativo
    'bbc.com',
    'nationalgeographic.com',
    'nationalgeographic.org',
    'natgeokids.com',
    'ted.com',                    // TED Talks / TED-Ed
    'ed.ted.com',
    'coursera.org',
    'edx.org',
    'archive.org',                // archive.org/details (libros, docs)
    'curriki.org',
    'ck12.org',
    'pbslearningmedia.org',
    'crashcourse.com',
    'commonsensemedia.org',
    'profedeele.es',              // recursos pedagógicos en español
    'educ.ar'                     // Educar.ar (Argentina, gobierno educativo)
];

function parseUrl(url) {
    try {
        return new URL(String(url || '').trim());
    } catch {
        return null;
    }
}

function hostname(url) {
    const parsed = typeof url === 'string' ? parseUrl(url) : url;
    return (parsed?.hostname || '').toLowerCase().replace(/^www\./, '');
}

function hostMatches(host, domain) {
    const h = (host || '').toLowerCase().replace(/^www\./, '');
    const d = domain.toLowerCase().replace(/^www\./, '');
    return h === d || h.endsWith(`.${d}`);
}

export function limpiarTrackingUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) return String(url || '').trim();
    for (const param of [...parsed.searchParams.keys()]) {
        if (TRACKING_PARAMS.has(param.toLowerCase()) || /^utm_/i.test(param)) {
            parsed.searchParams.delete(param);
        }
    }
    parsed.hash = '';
    return parsed.toString();
}

export function esYoutubeHost(url) {
    const host = hostname(url);
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
}

export function extraerYoutubeId(url) {
    const parsed = parseUrl(url);
    if (!parsed || !esYoutubeHost(parsed)) return null;

    const host = hostname(parsed);
    let id = null;
    if (host === 'youtu.be') {
        id = parsed.pathname.split('/').filter(Boolean)[0] || null;
    } else if (parsed.pathname === '/watch') {
        id = parsed.searchParams.get('v');
    } else {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(parts[0])) id = parts[1] || null;
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
}

export function esYoutubeVideoUrl(url) {
    return !!extraerYoutubeId(url);
}

export function esSearchPage(url) {
    const parsed = parseUrl(url);
    if (!parsed) return true;
    const host = hostname(parsed);
    const path = parsed.pathname.toLowerCase();

    if (hostMatches(host, 'google.com') || hostMatches(host, 'google.com.mx')) return true;
    if (hostMatches(host, 'youtube.com') && !esYoutubeVideoUrl(parsed.toString())) return true;
    if (path === '/search' || path.startsWith('/search/') || path === '/results') return true;
    if (parsed.searchParams.has('page_search_query')) return true;
    return false;
}

export function esFuenteProhibida(url) {
    const parsed = parseUrl(url);
    if (!parsed) return true;
    const host = hostname(parsed);
    if (BANNED_DOMAINS.some(domain => hostMatches(host, domain))) return true;
    return esSearchPage(parsed.toString());
}

export function esPdfUrl(url, contentType = '') {
    const parsed = parseUrl(url);
    if (!parsed) return false;
    return /application\/pdf/i.test(contentType) || /\.pdf$/i.test(parsed.pathname);
}

export function esDominioEducativo(url) {
    const parsed = parseUrl(url);
    if (!parsed) return false;
    const host = hostname(parsed);
    return TRUSTED_EDUCATIONAL_DOMAINS.some(domain => hostMatches(host, domain));
}

export function esDominioOkEducativo(url) {
    const parsed = parseUrl(url);
    if (!parsed) return false;
    const host = hostname(parsed);
    return EDUCATIONAL_OK_DOMAINS.some(domain => hostMatches(host, domain));
}

/**
 * Puntúa un recurso 0–100. >=50 se considera aceptable.
 *  - 100  → trusted educativo + PDF académico
 *  - 90   → trusted educativo (universidad, gob)
 *  - 80   → PDF en cualquier dominio no prohibido
 *  - 70   → ok educativo (Khan, BBC, NatGeo, TED, archive.org…)
 *  - 60   → video YouTube (válido como id, no canal/búsqueda)
 *  - 0    → prohibido o búsqueda
 */
export function puntuarRecurso(url, contentType = '') {
    const cleaned = limpiarTrackingUrl(url);
    if (esFuenteProhibida(cleaned)) return 0;

    const isPdf = esPdfUrl(cleaned, contentType);
    const trusted = esDominioEducativo(cleaned);
    const okTier = esDominioOkEducativo(cleaned);
    const isYoutube = esYoutubeVideoUrl(cleaned);

    if (trusted && isPdf) return 100;
    if (trusted) return 90;
    if (isPdf) return 80;
    if (okTier) return 70;
    if (isYoutube) return 60;
    return 30; // dominio no prohibido pero sin endorse específico
}

export function esUrlEducativaFinal(url, contentType = '') {
    return puntuarRecurso(url, contentType) >= 50;
}

export function tipoArticuloEducativo(url, contentType = '') {
    return esPdfUrl(url, contentType) ? 'PDF' : 'Articulo';
}

export function dominioBase(url) {
    return hostname(url);
}
