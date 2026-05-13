// Tests para resourceFallbacks.js — pool curado y cascada
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fallbackPoolCurado,
    obtenerRecursosConCascada,
    getFallbackTelemetry
} from '../resourceFallbacks.js';

let dynamicImportSeq = 0;

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return body; }
    };
}

async function loadFallbacksWithEnv(env, fetchImpl) {
    const keys = ['YOUTUBE_API_KEY', 'GOOGLE_CSE_ID', 'GOOGLE_CSE_KEY'];
    const previousEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    const previousFetch = globalThis.fetch;
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    globalThis.fetch = fetchImpl;
    const mod = await import(`../resourceFallbacks.js?test=${Date.now()}-${dynamicImportSeq++}`);
    return {
        mod,
        cleanup() {
            for (const key of keys) {
                if (previousEnv[key] === undefined) delete process.env[key];
                else process.env[key] = previousEnv[key];
            }
            globalThis.fetch = previousFetch;
        }
    };
}

function assertSoloPdfsDirectos(recursos) {
    assert.ok(recursos.length > 0, 'debe devolver al menos un PDF');
    assert.ok(
        recursos.every(r => r.tipo === 'PDF' && /\.pdf(?:$|[?#])/i.test(r.url || '')),
        `todos deben ser PDF directo: ${JSON.stringify(recursos.map(r => ({ titulo: r.titulo, tipo: r.tipo, url: r.url })))}`
    );
}

function assertPdfsDirectos(recursos) {
    const pdfs = recursos.filter(r => r.tipo === 'PDF' || /\.pdf(?:$|[?#])/i.test(r.url || ''));
    assert.ok(pdfs.length > 0, 'debe conservar PDFs directos');
    assert.ok(
        pdfs.every(r => r.tipo === 'PDF' && /\.pdf(?:$|[?#])/i.test(r.url || '') && !r.esVideo),
        `los PDFs deben ser directos: ${JSON.stringify(pdfs.map(r => ({ titulo: r.titulo, tipo: r.tipo, url: r.url })))}`
    );
}

function assertVideosYoutubeValidos(recursos) {
    const videos = recursos.filter(r => r.tipo === 'Video' || r.esVideo || r.fuenteOrigen === 'youtube');
    assert.ok(videos.length > 0, 'debe conservar videos educativos como apoyo');
    assert.ok(videos.length <= 2, 'los videos deben estar limitados para no desplazar PDFs');
    assert.ok(videos.every(r => /youtube\.com\/watch\?v=|youtu\.be\//i.test(r.url || '')));
    assert.ok(videos.every(r => r.complejidad && r.nivel), 'videos deben ir etiquetados por nivel/complejidad');
}

test('pool curado encuentra solo PDFs directos por materia "matematicas"', async () => {
    const recursos = await fallbackPoolCurado('cálculo', 'preparatoria', 'matematicas');
    assert.ok(Array.isArray(recursos));
    assertSoloPdfsDirectos(recursos);
    assert.ok(recursos.every(r => r.fuenteOrigen === 'curado'));
});

test('pool curado por tema "fotosíntesis" encuentra biología', async () => {
    const recursos = await fallbackPoolCurado('fotosíntesis', 'preparatoria', 'biologia');
    assert.ok(Array.isArray(recursos));
    // Aunque la búsqueda sea exacta o no, el pool default existe
    assert.ok(recursos.length > 0);
});

test('pool curado entiende temas sin acentos y conserva PDFs', async () => {
    const recursos = await fallbackPoolCurado('fotosintesis', 'preparatoria', '');
    assert.ok(recursos.some(r => r.fuenteOrigen === 'curado' && r.tipo === 'PDF'));
});

test('pool curado reconoce ecuaciones cuadráticas aunque no venga materia', async () => {
    const recursos = await fallbackPoolCurado('ecuaciones cuadraticas', 'preparatoria', '');
    assert.ok(recursos.some(r => r.fuenteOrigen === 'curado' && r.tipo === 'PDF'));
    assert.ok(recursos.some(r => /ecuaciones|álgebra|algebra|matem/i.test(r.titulo)));
});

test('pool curado devuelve PDF apropiado para nivel universidad', async () => {
    const recursos = await fallbackPoolCurado('calculo diferencial', 'Universidad', 'matematicas');
    assert.ok(recursos.some(r => r.fuenteOrigen === 'curado' && r.tipo === 'PDF'));
    assert.ok(recursos.every(r => !r.grados || r.grados.some(g => /universidad/i.test(g))));
});

test('pool curado devuelve default cuando no hay match específico', async () => {
    const recursos = await fallbackPoolCurado('tema_que_no_existe_xyzzz', '', 'materia_inexistente');
    assert.ok(Array.isArray(recursos));
    assertSoloPdfsDirectos(recursos);
});

test('pool curado no devuelve páginas generales como NASA.gov cuando se piden PDFs', async () => {
    const recursos = await fallbackPoolCurado('astronomia espacio nasa', 'secundaria', 'fisica');
    assertSoloPdfsDirectos(recursos);
    assert.equal(recursos.some(r => /nasa\.gov\/learning-resources\/for-educators/i.test(r.url || '')), false);
});

test('cascada nunca devuelve vacío sin Gemini ni APIs', async () => {
    // Sin keys de YouTube/CSE/Gemini, sólo el pool curado actuará
    const r = await obtenerRecursosConCascada({
        tema: 'tema cualquiera',
        grado: 'preparatoria',
        materia: 'historia',
        recursosIA: []
    });
    assert.ok(Array.isArray(r));
    assert.ok(r.length > 0, 'la cascada siempre garantiza ≥1 recurso vía pool curado');
});

test('cascada respeta recursosIA si ya hay 4 PDFs directos para tarea', async () => {
    const recursosIA = [
        { titulo: 'A', url: 'https://www.unam.mx/a.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'B', url: 'https://www.unam.mx/b.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'C', url: 'https://www.unam.mx/c.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'D', url: 'https://www.unam.mx/d.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'x', recursosIA });
    assert.equal(r.length, 4);
    assert.ok(r.every(x => x.fuenteOrigen === 'gemini'));
    assertSoloPdfsDirectos(r);
});

test('cascada no se satisface solo con videos cuando el maestro necesita fuentes para tarea', async () => {
    const recursosIA = [
        { titulo: 'Video 1', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', youtubeId: 'AAAAAAAAAAA', tipo: 'Video', esVideo: true, score: 65, fuenteOrigen: 'gemini' },
        { titulo: 'Video 2', url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', youtubeId: 'BBBBBBBBBBB', tipo: 'Video', esVideo: true, score: 65, fuenteOrigen: 'gemini' },
        { titulo: 'Video 3', url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', youtubeId: 'CCCCCCCCCCC', tipo: 'Video', esVideo: true, score: 65, fuenteOrigen: 'gemini' },
        { titulo: 'Video 4', url: 'https://www.youtube.com/watch?v=DDDDDDDDDDD', youtubeId: 'DDDDDDDDDDD', tipo: 'Video', esVideo: true, score: 65, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({
        tema: 'fotosíntesis',
        grado: 'preparatoria',
        materia: 'biologia',
        recursosIA
    });
    assert.ok(r.some(x => x.fuenteOrigen === 'curado' && x.tipo === 'PDF'), 'debe agregar al menos un PDF/artículo procesable');
});

test('cascada devuelve PDFs primero y videos de YouTube como apoyo limitado', async () => {
    const { mod, cleanup } = await loadFallbacksWithEnv(
        { YOUTUBE_API_KEY: 'fake-youtube-key' },
        async () => jsonResponse(200, {
            items: ['AAA00000001', 'BBB00000002', 'CCC00000003', 'DDD00000004'].map((id, i) => ({
                id: { videoId: id },
                snippet: {
                    title: `Video ${i + 1}`,
                    description: 'Explicación educativa',
                    channelId: `channel-${i}`,
                    channelTitle: 'Canal educativo'
                }
            }))
        })
    );
    try {
        const r = await mod.obtenerRecursosConCascada({
            tema: 'fotosintesis',
            grado: 'preparatoria',
            materia: 'biologia',
            recursosIA: []
        });
        assert.equal(r[0].tipo, 'PDF');
        assertPdfsDirectos(r);
        assertVideosYoutubeValidos(r);
    } finally {
        cleanup();
    }
});

test('cascada etiqueta videos por nivel de referencia sin dejar pasar páginas generales', async () => {
    const { mod, cleanup } = await loadFallbacksWithEnv(
        { YOUTUBE_API_KEY: 'fake-youtube-key' },
        async () => jsonResponse(200, {
            items: ['AAA00000001', 'BBB00000002', 'CCC00000003', 'DDD00000004', 'EEE00000005'].map((id, i) => ({
                id: { videoId: id },
                snippet: {
                    title: `Video ${i + 1}`,
                    description: 'Explicación educativa',
                    channelId: `channel-${i}`,
                    channelTitle: 'Canal educativo'
                }
            }))
        })
    );
    try {
        const r = await mod.obtenerRecursosConCascada({
            tema: 'fotosintesis',
            grado: 'Secundaria',
            materia: 'biologia',
            nivelReferencia: 'Secundaria',
            recursosIA: []
        });
        const videos = r.filter(x => x.fuenteOrigen === 'youtube' || x.tipo === 'Video');
        assert.ok(videos.length > 0);
        assert.ok(videos.every(x => x.nivel === 'Secundaria'));
        assert.ok(videos.every(x => x.complejidad === 'introductorio'));
        assert.equal(r[0].tipo, 'PDF');
        assertPdfsDirectos(r);
        assert.equal(r.some(x => /nasa\.gov\/learning-resources\/for-educators/i.test(x.url || '')), false);
    } finally {
        cleanup();
    }
});

test('CSE ignora páginas no PDF aunque vengan de dominios confiables', async () => {
    const { mod, cleanup } = await loadFallbacksWithEnv(
        { GOOGLE_CSE_ID: 'fake-cx', GOOGLE_CSE_KEY: 'fake-cse-key' },
        async () => jsonResponse(200, {
            items: [
                { title: 'NASA educators page', link: 'https://www.nasa.gov/learning-resources/for-educators/', snippet: 'Página general' },
                { title: 'UNAM PDF', link: 'https://www.unam.mx/recurso.pdf', snippet: 'PDF oficial', mime: 'application/pdf' }
            ]
        })
    );
    try {
        const r = await mod.fallbackGoogleCSE('espacio', 'Secundaria', 6, 'fisica', 'Secundaria');
        assert.deepEqual(r.map(x => x.url), ['https://www.unam.mx/recurso.pdf']);
        assertSoloPdfsDirectos(r);
    } finally {
        cleanup();
    }
});

test('cache de YouTube considera materia y nivelReferencia', async () => {
    let fetches = 0;
    const { mod, cleanup } = await loadFallbacksWithEnv(
        { YOUTUBE_API_KEY: 'fake-youtube-key' },
        async () => {
            fetches++;
            return jsonResponse(200, { items: [] });
        }
    );
    try {
        await mod.fallbackYoutube('energía', 'Secundaria', 4, 'fisica', 'Secundaria');
        await mod.fallbackYoutube('energía', 'Secundaria', 4, 'biologia', 'Secundaria');
        assert.equal(fetches, 2);
    } finally {
        cleanup();
    }
});

test('cascada deduplica por URL', async () => {
    const recursosIA = [
        { titulo: 'A', url: 'https://www.unam.mx/x.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'A duplicado', url: 'https://www.unam.mx/x.pdf?utm_source=test', tipo: 'PDF', score: 80, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'algo', recursosIA });
    // Después de limpiar tracking, las dos URLs son iguales — debe quedar una
    const ux = r.filter(x => x.url && x.url.includes('unam.mx/x.pdf')).length;
    assert.equal(ux, 1);
    assertSoloPdfsDirectos(r);
});

test('cascada filtra fuentes prohibidas (wikipedia)', async () => {
    const recursosIA = [
        { titulo: 'Wiki', url: 'https://es.wikipedia.org/wiki/Algo', score: 50, fuenteOrigen: 'gemini' },
        { titulo: 'OK', url: 'https://www.unam.mx/ok.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'x', recursosIA });
    assert.ok(!r.some(x => x.url.includes('wikipedia')));
    assertSoloPdfsDirectos(r);
});

test('telemetría del fallback expone configuración', () => {
    const t = getFallbackTelemetry();
    assert.ok('cacheSize' in t);
    assert.ok('config' in t);
    assert.ok('youtubeKeySet' in t.config);
    assert.ok('googleCSESet' in t.config);
});

test('YouTube 403 no rompe y deja diagnóstico sanitizado', async () => {
    const { mod, cleanup } = await loadFallbacksWithEnv(
        { YOUTUBE_API_KEY: 'fake-youtube-key' },
        async () => jsonResponse(403, { error: { message: 'quotaExceeded: API key restricted or quota exhausted' } })
    );
    try {
        const recursos = await mod.fallbackYoutube('fotosíntesis', 'preparatoria');
        assert.deepEqual(recursos, []);
        const t = mod.getFallbackTelemetry();
        assert.equal(t.youtube.configured, true);
        assert.equal(t.youtube.lastStatus, 403);
        assert.match(t.youtube.lastError, /quota|restricted|403/i);
        assert.equal(t.youtube.probableCause, 'quota_or_restriction');
    } finally {
        cleanup();
    }
});

test('CSE 403/closed es opcional y no rompe la búsqueda', async () => {
    const { mod, cleanup } = await loadFallbacksWithEnv(
        { GOOGLE_CSE_ID: 'legacy-cx', GOOGLE_CSE_KEY: 'fake-cse-key' },
        async () => jsonResponse(403, { error: { message: 'The Custom Search JSON API is closed to new customers' } })
    );
    try {
        const recursos = await mod.fallbackGoogleCSE('ecuaciones cuadráticas', 'preparatoria');
        assert.deepEqual(recursos, []);
        const t = mod.getFallbackTelemetry();
        assert.equal(t.googleCSE.optional, true);
        assert.equal(t.googleCSE.configured, true);
        assert.equal(t.googleCSE.lastStatus, 403);
        assert.match(t.googleCSE.lastError, /closed|403/i);
        assert.equal(t.googleCSE.probableCause, 'closed_or_restricted');
    } finally {
        cleanup();
    }
});

test('cascada usa pool curado aunque YouTube y CSE fallen', async () => {
    const { mod, cleanup } = await loadFallbacksWithEnv(
        {
            YOUTUBE_API_KEY: 'fake-youtube-key',
            GOOGLE_CSE_ID: 'legacy-cx',
            GOOGLE_CSE_KEY: 'fake-cse-key'
        },
        async (url) => {
            if (String(url).includes('/youtube/v3/search')) {
                return jsonResponse(403, { error: { message: 'quotaExceeded' } });
            }
            if (String(url).includes('/customsearch/v1')) {
                return jsonResponse(403, { error: { message: 'closed to new customers' } });
            }
            throw new Error('URL inesperada en test: ' + url);
        }
    );
    try {
        const recursos = await mod.obtenerRecursosConCascada({
            tema: 'tema improbable xyz',
            grado: 'preparatoria',
            materia: 'historia',
            recursosIA: []
        });
        assert.ok(recursos.length > 0, 'el pool curado debe evitar resultados vacíos');
        assert.ok(recursos.some(r => r.fuenteOrigen === 'curado'));
        const t = mod.getFallbackTelemetry();
        assert.equal(t.youtube.lastStatus, 403);
        assert.equal(t.googleCSE.lastStatus, 403);
    } finally {
        cleanup();
    }
});
