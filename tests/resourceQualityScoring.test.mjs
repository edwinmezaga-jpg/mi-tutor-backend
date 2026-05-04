// Tests para el scoring 0-100 de resourceQuality.js (v2.0.0.6)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    puntuarRecurso,
    esUrlEducativaFinal,
    esDominioOkEducativo,
    esFuenteProhibida
} from '../resourceQuality.js';

test('UNAM (trusted) puntúa 90+', () => {
    const score = puntuarRecurso('https://www.unam.mx/article/something');
    assert.ok(score >= 90, `Esperado >=90, recibido ${score}`);
});

test('PDF en gob.mx puntúa 100', () => {
    const score = puntuarRecurso('https://www.gob.mx/cms/uploads/document.pdf');
    assert.equal(score, 100);
});

test('Khan Academy (ok-tier) puntúa 70', () => {
    const score = puntuarRecurso('https://es.khanacademy.org/math/algebra');
    assert.equal(score, 70);
    assert.equal(esDominioOkEducativo('https://es.khanacademy.org/'), true);
});

test('Wikipedia sigue prohibida en v2.0.0.6', () => {
    assert.equal(esFuenteProhibida('https://es.wikipedia.org/wiki/Foton'), true);
    assert.equal(puntuarRecurso('https://es.wikipedia.org/wiki/Foton'), 0);
});

test('YouTube video válido puntúa 60', () => {
    const score = puntuarRecurso('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(score, 60);
});

test('YouTube página de búsqueda es prohibida', () => {
    assert.equal(esFuenteProhibida('https://www.youtube.com/results?search_query=algo'), true);
});

test('Google Search es prohibido', () => {
    assert.equal(esFuenteProhibida('https://www.google.com/search?q=algo'), true);
});

test('PDF aleatorio no en lista trusted puntúa 80', () => {
    const score = puntuarRecurso('https://example.com/document.pdf');
    assert.equal(score, 80);
});

test('TED-Ed (ok-tier) puntúa 70', () => {
    const score = puntuarRecurso('https://ed.ted.com/lessons/something');
    assert.equal(score, 70);
});

test('NASA.gov (trusted) puntúa 90', () => {
    const score = puntuarRecurso('https://www.nasa.gov/article');
    assert.equal(score, 90);
});

test('archive.org (ok-tier) puntúa 70', () => {
    const score = puntuarRecurso('https://archive.org/details/somebook');
    assert.equal(score, 70);
});

test('esUrlEducativaFinal mantiene compat con scoring >= 50', () => {
    assert.equal(esUrlEducativaFinal('https://www.unam.mx/'), true);
    assert.equal(esUrlEducativaFinal('https://es.khanacademy.org/'), true); // 70
    assert.equal(esUrlEducativaFinal('https://es.wikipedia.org/'), false);
    assert.equal(esUrlEducativaFinal('https://www.youtube.com/watch?v=abc12345678'), true); // 60
});
