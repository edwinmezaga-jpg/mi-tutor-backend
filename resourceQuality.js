const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_reader', 'utm_viz_id', 'utm_pubreferrer',
    'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid', 'si',
    'feature', 'ab_channel', 'pp'
]);

const BANNED_DOMAINS = [
    'wikipedia.org',
    'wikimedia.org',
    'wikiwand.com',
    'khanacademy.org',
    'google.com',
    'google.com.mx'
];

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

export function esUrlEducativaFinal(url, contentType = '') {
    const cleaned = limpiarTrackingUrl(url);
    if (esFuenteProhibida(cleaned)) return false;
    return esPdfUrl(cleaned, contentType) || esDominioEducativo(cleaned);
}

export function tipoArticuloEducativo(url, contentType = '') {
    return esPdfUrl(url, contentType) ? 'PDF' : 'Articulo';
}

export function dominioBase(url) {
    return hostname(url);
}
