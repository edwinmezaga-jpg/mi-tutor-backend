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

test('buscarRecursos envía tema, grado y materia al backend', async () => {
    const html = await readFrontend();
    assert.match(
        html,
        /body:\s*JSON\.stringify\(\{\s*tema,\s*grado,\s*materia\s*\}\)/s
    );
});
