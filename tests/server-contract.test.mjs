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
    assert.match(js, /const\s+temaBusquedaIA\s*=\s*\[\s*tema,\s*materia\s*\|\|\s*''\s*,\s*nivelEfectivo\s*\]/s);
    assert.match(js, /buscarRecursosEducativosIA\(temaBusquedaIA\)/);
    assert.match(js, /obtenerRecursosConCascada\(\{\s*tema,\s*grado:\s*nivelEfectivo,\s*materia:\s*materia\s*\|\|\s*'',\s*nivelReferencia:\s*nivelEfectivo/s);
});

test('/api/maestro/recursos expone conteo de PDFs y fuentes para tarea en fallbackResumen', async () => {
    const js = await readServer();
    assert.match(js, /taskReadyCount:\s*fallbackTelemetry\.lastCascade\?\.taskReadyCount/s);
    assert.match(js, /pdfCount:\s*fallbackTelemetry\.lastCascade\?\.pdfCount/s);
});

test('Gemini grounding de recursos pide PDFs directos y videos opcionales', async () => {
    const js = await readServer();
    assert.match(js, /PDFs directos primero/);
    assert.match(js, /videos educativos opcionales/);
    assert.match(js, /data\.articulos\s*=\s*\(data\.articulos\s*\|\|\s*\[\]\)\.filter\(a\s*=>\s*a\?\.url\s*&&\s*esPdfUrl\(a\.url\)\)/);
    assert.match(js, /\{"videos":\[\{"titulo":/);
    assert.match(js, /videoCount:\s*fallbackTelemetry\.lastCascade\?\.videoCount/s);
});

test('backend visible se identifica como Beta 3.0.0', async () => {
    const js = await readServer();
    assert.match(js, /APP_VERSION\s*=\s*'Beta 3\.0\.0'/);
    assert.match(js, /PACKAGE_VERSION\s*=\s*'3\.0\.0-beta\.0'/);
});

test('admin puede editar y borrar directores con endpoints dedicados', async () => {
    const js = await readServer();
    assert.match(js, /app\.patch\('\/api\/admin\/director\/:directorId'/);
    assert.match(js, /app\.delete\('\/api\/admin\/director\/:directorId'/);
});
