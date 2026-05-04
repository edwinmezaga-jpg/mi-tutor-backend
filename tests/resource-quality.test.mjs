import test from 'node:test';
import assert from 'node:assert/strict';

import {
    limpiarTrackingUrl,
    extraerYoutubeId,
    esYoutubeVideoUrl,
    esFuenteProhibida,
    esUrlEducativaFinal,
    tipoArticuloEducativo
} from '../resourceQuality.js';

test('extrae IDs solo de URLs reales de video de YouTube', () => {
    assert.equal(extraerYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
    assert.equal(extraerYoutubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
    assert.equal(extraerYoutubeId('https://www.youtube.com/results?search_query=historia+de+mexico'), null);
    assert.equal(extraerYoutubeId('https://img.youtube.com/vi/not-valid/mqdefault.jpg'), null);
});

test('reconoce videos de YouTube finales y rechaza paginas de busqueda', () => {
    assert.equal(esYoutubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(esYoutubeVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'), true);
    assert.equal(esYoutubeVideoUrl('https://www.youtube.com/results?search_query=biologia'), false);
    assert.equal(esYoutubeVideoUrl('https://www.youtube.com/@canal'), false);
});

test('bloquea fuentes que no deben aparecer como recurso validado', () => {
    assert.equal(esFuenteProhibida('https://es.wikipedia.org/wiki/Benito_Juarez'), true);
    assert.equal(esFuenteProhibida('https://es.khanacademy.org/search?page_search_query=algebra'), true);
    assert.equal(esFuenteProhibida('https://scholar.google.com/scholar?q=fotosintesis'), true);
    assert.equal(esFuenteProhibida('https://www.google.com/search?q=mitosis'), true);
    assert.equal(esFuenteProhibida('https://www.youtube.com/results?search_query=quimica'), true);
});

test('acepta PDFs e instituciones como fuentes finales', () => {
    assert.equal(esUrlEducativaFinal('https://www.gob.mx/cms/uploads/attachment/file/123/guia.pdf'), true);
    assert.equal(esUrlEducativaFinal('https://www.unam.mx/investigacion/articulo'), true);
    assert.equal(esUrlEducativaFinal('https://repositorio.colmex.mx/concern/books/abc.pdf'), true);
    assert.equal(esUrlEducativaFinal('https://blog-generico.example.com/la-conquista'), false);
});

test('limpia tracking sin convertir buscadores en fuentes', () => {
    assert.equal(
        limpiarTrackingUrl('https://www.unam.mx/recurso.pdf?utm_source=x&si=abc&download=1'),
        'https://www.unam.mx/recurso.pdf?download=1'
    );
    assert.equal(tipoArticuloEducativo('https://www.sep.gob.mx/material.pdf'), 'PDF');
    assert.equal(tipoArticuloEducativo('https://www.ipn.mx/oferta/curso'), 'Articulo');
});
