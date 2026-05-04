// Tests para el clasificador de intención (sin Gemini key sólo prueba fallback heurístico)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clasificarIntencion } from '../aiClient.js';

// Estos tests funcionan sin GEMINI_API_KEY: el clasificador cae a heurística
// si la IA no responde, y nuestros tests verifican esa heurística mínima.

test('mensaje vacío → fuera_tema', async () => {
    const r = await clasificarIntencion('');
    assert.equal(r.intent, 'fuera_tema');
});

test('"quiero aprender X" → leccion (heurística cubre fallback)', async () => {
    const r = await clasificarIntencion('quiero aprender fotosíntesis');
    // Con GEMINI_API_KEY → la IA decidirá. Sin key → heurística marca "leccion".
    // Aceptamos ambos resultados pero no permitimos "fuera_tema".
    assert.notEqual(r.intent, 'fuera_tema');
});

test('respuesta tiene campos mínimos', async () => {
    const r = await clasificarIntencion('algo simple');
    assert.ok('intent' in r);
    assert.ok('confianza' in r);
    assert.ok(typeof r.confianza === 'number');
    assert.ok(r.confianza >= 0 && r.confianza <= 1);
});

test('intent es uno de los esperados', async () => {
    const r = await clasificarIntencion('cómo se conjuga el verbo ser en pasado');
    assert.ok(['leccion', 'duda', 'seguimiento', 'fuera_tema'].includes(r.intent));
});

test('mensaje de 1 carácter → fuera_tema', async () => {
    const r = await clasificarIntencion('a');
    assert.equal(r.intent, 'fuera_tema');
});

test('confianza está acotada entre 0 y 1', async () => {
    const inputs = ['hola', 'aprender derivadas', 'qué es la mitocondria', '', 'xy'];
    for (const i of inputs) {
        const r = await clasificarIntencion(i);
        assert.ok(r.confianza >= 0);
        assert.ok(r.confianza <= 1);
    }
});
