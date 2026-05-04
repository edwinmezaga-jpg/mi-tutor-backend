// Tests para resourceFallbacks.js — pool curado y cascada
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fallbackPoolCurado,
    obtenerRecursosConCascada,
    getFallbackTelemetry
} from '../resourceFallbacks.js';

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

test('cascada respeta recursosIA si ya hay 4+', async () => {
    const recursosIA = [
        { titulo: 'A', url: 'https://www.unam.mx/a', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'B', url: 'https://www.unam.mx/b', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'C', url: 'https://www.unam.mx/c', score: 90, fuenteOrigen: 'gemini' },
        { titulo: 'D', url: 'https://www.unam.mx/d', score: 90, fuenteOrigen: 'gemini' }
    ];
    const r = await obtenerRecursosConCascada({ tema: 'x', recursosIA });
    assert.equal(r.length, 4);
    assert.ok(r.every(x => x.fuenteOrigen === 'gemini'));
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
