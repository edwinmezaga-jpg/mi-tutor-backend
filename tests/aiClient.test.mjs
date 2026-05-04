// Tests para aiClient.js — validación de schema y resilencia
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema } from '../aiClient.js';

test('schema válido pasa', () => {
    const r = validateAgainstSchema(
        { titulo: 'Hola mundo', resumen: 'a'.repeat(50) },
        { type: 'object', required: ['titulo', 'resumen'], properties: {
            titulo: { type: 'string', minLength: 4 },
            resumen: { type: 'string', minLength: 30 }
        }}
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
});

test('campo requerido faltante falla', () => {
    const r = validateAgainstSchema(
        { titulo: 'Hola' }, // falta resumen
        { type: 'object', required: ['titulo', 'resumen'] }
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('resumen')));
});

test('tipo incorrecto falla', () => {
    const r = validateAgainstSchema(
        { num: 'no es número' },
        { type: 'object', properties: { num: { type: 'number' } } }
    );
    assert.equal(r.ok, false);
});

test('array con minItems', () => {
    const r1 = validateAgainstSchema(
        { quiz: [1, 2] },
        { type: 'object', properties: { quiz: { type: 'array', minItems: 3 } } }
    );
    assert.equal(r1.ok, false);
    const r2 = validateAgainstSchema(
        { quiz: [1, 2, 3, 4] },
        { type: 'object', properties: { quiz: { type: 'array', minItems: 3 } } }
    );
    assert.equal(r2.ok, true);
});

test('string vacío en required falla', () => {
    const r = validateAgainstSchema(
        { titulo: '', resumen: 'x'.repeat(50) },
        { type: 'object', required: ['titulo'] }
    );
    assert.equal(r.ok, false);
});

test('null en required falla', () => {
    const r = validateAgainstSchema(
        { titulo: null },
        { type: 'object', required: ['titulo'] }
    );
    assert.equal(r.ok, false);
});

test('object anidado valida recursivamente', () => {
    const r = validateAgainstSchema(
        { meta: { titulo: 'x' } },
        { type: 'object', properties: {
            meta: { type: 'object', required: ['titulo', 'descripcion'] }
        }}
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('descripcion')));
});
