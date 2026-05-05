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

test('pool curado encuentra recursos por materia "matematicas"', async () => {
    const recursos = await fallbackPoolCurado('cálculo', 'preparatoria', 'matematicas');
    assert.ok(Array.isArray(recursos));
    assert.ok(recursos.length > 0, 'pool curado debería tener al menos 1 recurso de matemáticas');
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

test('pool curado devuelve default cuando no hay match específico', async () => {
    const recursos = await fallbackPoolCurado('tema_que_no_existe_xyzzz', '', 'materia_inexistente');
    assert.ok(Array.isArray(recursos));
    assert.ok(recursos.length > 0, 'siempre debe devolver al menos los del default pool');
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

test('cascada respeta recursosIA si ya hay 4+ incluyendo PDF para tarea', async () => {
    const recursosIA = [
        { titulo: 'A', url: 'https://www.unam.mx/a', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'B', url: 'https://www.unam.mx/b', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'C', url: 'https://www.unam.mx/c', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'D', url: 'https://www.unam.mx/d.pdf', tipo: 'PDF', score: 90, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'x', recursosIA });
    assert.equal(r.length, 4);
    assert.ok(r.every(x => x.fuenteOrigen === 'gemini'));
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

test('cascada agrega PDF aunque YouTube sí devuelva suficientes videos', async () => {
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
        assert.ok(r.some(x => x.fuenteOrigen === 'youtube'));
        assert.ok(r.some(x => x.fuenteOrigen === 'curado' && x.tipo === 'PDF'));
    } finally {
        cleanup();
    }
});

test('cascada deduplica por URL', async () => {
    const recursosIA = [
        { titulo: 'A', url: 'https://www.unam.mx/x', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'A duplicado', url: 'https://www.unam.mx/x?utm_source=test', score: 80, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'algo', recursosIA });
    // Después de limpiar tracking, las dos URLs son iguales — debe quedar una
    const ux = r.filter(x => x.url && x.url.includes('unam.mx/x')).length;
    assert.equal(ux, 1);
});

test('cascada filtra fuentes prohibidas (wikipedia)', async () => {
    const recursosIA = [
        { titulo: 'Wiki', url: 'https://es.wikipedia.org/wiki/Algo', score: 50, fuenteOrigen: 'gemini' },
        { titulo: 'OK', url: 'https://www.unam.mx/ok', score: 90, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'x', recursosIA });
    assert.ok(!r.some(x => x.url.includes('wikipedia')));
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
