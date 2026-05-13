import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendPath = path.resolve(__dirname, '../../FRONTEND/index.html');

async function readFrontend() {
    return readFile(frontendPath, 'utf8');
}

test('mobile hamburger no usa detector genérico que mueve el body', async () => {
    const html = await readFrontend();
    assert.equal(html.includes('detectHamburger'), false);
    assert.equal(html.includes('has-fixed-hamburger'), false);
});

test('portal maestro mobile mantiene header y filtros estables', async () => {
    const html = await readFrontend();
    assert.match(html, /#maestroOverlay\s*>\s*\.maestro-container\s*>\s*\.maestro-header\s*\{[^}]*position:sticky/s);
    assert.match(html, /#maestroOverlay\s+\.maestro-workbar\s*\{[^}]*top:calc\(env\(safe-area-inset-top,\s*0px\)\s*\+\s*64px\)/s);
    assert.match(html, /#maestroOverlay\s+\.maestro-workbar\s*\{[^}]*margin:0 0 12px/s);
});

test('buscarRecursos envía tema, grado, materia y nivelReferencia al backend', async () => {
    const html = await readFrontend();
    assert.match(
        html,
        /body:\s*JSON\.stringify\(\{\s*tema,\s*grado,\s*materia,\s*nivelReferencia\s*\}\)/s
    );
});

test('buscador de recursos ofrece exactamente los tres niveles de referencia Beta 3.0', async () => {
    const html = await readFrontend();
    assert.match(html, /id="nivelReferenciaRecursos"/);
    for (const nivel of ['Secundaria', 'Preparatoria', 'Universidad']) {
        assert.match(html, new RegExp(`data-nivel="${nivel}"`));
    }
    assert.equal(/data-nivel="Posgrado"/.test(html), false);
});

test('frontend visible se identifica como Beta 3.0.0', async () => {
    const html = await readFrontend();
    assert.match(html, /Beta 3\.0\.0/);
});

test('admin reset usa modal seguro y no prompt nativo', async () => {
    const html = await readFrontend();
    assert.match(html, /adminPasswordResetOverlay/);
    assert.match(html, /confirmarAccionAdmin/);
    assert.equal(/prompt\(`Nueva contraseña/.test(html), false);
});

test('borrados administrativos clave usan confirmación con frase requerida', async () => {
    const html = await readFrontend();
    for (const fn of [
        'quitarGrupoAdmin',
        'eliminarInvitacion',
        'borrarMaestro',
        'borrarAlumno',
        'borrarGrupo',
        'depurarTodo',
        'borrarDirectorAdmin',
        'borrarAlumnoAdmin'
    ]) {
        const start = html.indexOf(`async function ${fn}`);
        assert.ok(start >= 0, `No se encontró ${fn}`);
        const rest = html.slice(start + 1);
        const nextMatch = rest.match(/\n(?:async\s+)?function\s+\w+/);
        const segment = html.slice(start, nextMatch ? start + 1 + nextMatch.index : undefined);
        assert.match(segment, /confirmarAccionAdmin\(\{/);
        assert.equal(/confirm\(/.test(segment), false, `${fn} no debe usar confirm() nativo`);
    }
});

test('frontend de recursos promete PDFs primero y videos por nivel', async () => {
    const html = await readFrontend();
    assert.match(html, /PDFs directos primero, videos como apoyo por nivel/);
    assert.match(html, /const\s+isDirectPdf\s*=\s*\(r\)\s*=>/);
    assert.match(html, /const\s+isVideoResource\s*=\s*\(r\)\s*=>/);
    assert.match(html, /Videos educativos/);
    assert.match(html, /Buscar recursos/);
    assert.equal(/Se descartan páginas generales, artículos HTML y videos/.test(html), false);
});
