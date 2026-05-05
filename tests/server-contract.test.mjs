import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '../server.js');

async function readServer() {
    return readFile(serverPath, 'utf8');
}

test('/api/maestro/recursos usa materia y grado también en Gemini grounding', async () => {
    const js = await readServer();
    assert.match(js, /const\s+temaBusquedaIA\s*=\s*\[\s*tema,\s*materia\s*\|\|\s*''\s*,\s*grado\s*\|\|\s*''\s*\]/s);
    assert.match(js, /buscarRecursosEducativosIA\(temaBusquedaIA\)/);
});

test('/api/maestro/recursos expone conteo de PDFs y fuentes para tarea en fallbackResumen', async () => {
    const js = await readServer();
    assert.match(js, /taskReadyCount:\s*fallbackTelemetry\.lastCascade\?\.taskReadyCount/s);
    assert.match(js, /pdfCount:\s*fallbackTelemetry\.lastCascade\?\.pdfCount/s);
});
