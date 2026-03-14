import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
    console.error("⚠️  FALTA GEMINI_API_KEY en Render → Environment");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
});

// Ruta donde Render guarda el binario de yt-dlp
const YTDLP = '/opt/render/project/src/yt-dlp';

// ── Extrae el video ID de cualquier URL de YouTube
function extraerVideoId(url) {
    const patterns = [
        /youtu\.be\/([^?&\s]+)/,
        /youtube\.com\/watch\?v=([^&\s]+)/,
        /youtube\.com\/embed\/([^?&\s]+)/,
        /youtube\.com\/shorts\/([^?&\s]+)/,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

// ── Descarga subtítulos con yt-dlp y devuelve el texto
async function obtenerSubtitulosYouTube(videoId) {
    const tmpDir = '/tmp';
    const tmpBase = join(tmpDir, `sub_${videoId}_${Date.now()}`);

    try {
        // Intenta español primero, luego inglés, luego automáticos
        const cmd = `${YTDLP} \
            --skip-download \
            --write-subs \
            --write-auto-subs \
            --sub-langs "es,es-MX,es-419,en" \
            --sub-format vtt \
            --convert-subs vtt \
            -o "${tmpBase}" \
            "https://www.youtube.com/watch?v=${videoId}" \
            2>&1`;

        console.log(`📺 Descargando subtítulos del video: ${videoId}`);
        await execAsync(cmd, { timeout: 30000 });

        // Buscar el archivo .vtt que se generó
        const files = await readdir(tmpDir);
        const vttFile = files.find(f => f.startsWith(`sub_${videoId}`) && f.endsWith('.vtt'));

        if (!vttFile) {
            throw new Error('No se encontraron subtítulos para este video.');
        }

        const fullPath = join(tmpDir, vttFile);
        const vttContent = await readFile(fullPath, 'utf8');

        // Limpiar archivo temporal
        await unlink(fullPath).catch(() => {});

        // Parsear el VTT y extraer solo el texto
        const texto = vttContent
            .split('\n')
            .filter(line =>
                line.trim() &&
                !line.startsWith('WEBVTT') &&
                !line.startsWith('NOTE') &&
                !line.match(/^\d{2}:\d{2}/) && // timestamps
                !line.match(/^[\d]+$/)           // números de índice
            )
            .map(line => line.replace(/<[^>]+>/g, '').trim()) // quitar tags HTML
            .filter(line => line.length > 0)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!texto) throw new Error('Los subtítulos estaban vacíos.');

        console.log(`✅ Subtítulos extraídos: ${texto.length} caracteres`);
        return texto;

    } catch (e) {
        // Limpiar archivos temporales en caso de error
        try {
            const files = await readdir(tmpDir);
            const tmpFiles = files.filter(f => f.startsWith(`sub_${videoId}`));
            await Promise.all(tmpFiles.map(f => unlink(join(tmpDir, f)).catch(() => {})));
        } catch {}

        throw new Error(`No se pudieron obtener los subtítulos: ${e.message}`);
    }
}

// ── Decide si es YouTube o texto directo
async function obtenerTexto(input) {
    const esYoutube = /youtu\.be|youtube\.com/i.test(input);
    if (!esYoutube) return input;

    const videoId = extraerVideoId(input);
    if (!videoId) throw new Error('No se pudo leer el ID del video. Verifica el link.');

    return await obtenerSubtitulosYouTube(videoId);
}

// ── POST /api/estudiar
app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta el campo 'input'." });

        const sourceText = await obtenerTexto(input);

        const prompt = `Actúa como un tutor experto para estudiantes de secundaria y preparatoria.
Analiza el siguiente contenido y responde ÚNICAMENTE con un JSON válido, sin texto extra antes ni después, sin bloques de código markdown:
{
  "titulo": "Título claro del tema",
  "resumen": "Resumen explicativo en 3 párrafos usando lenguaje sencillo, separados por saltos de línea",
  "quiz": [
    {"p": "Pregunta 1", "o": ["Opción A", "Opción B", "Opción C"], "r": 0},
    {"p": "Pregunta 2", "o": ["Opción A", "Opción B", "Opción C"], "r": 1},
    {"p": "Pregunta 3", "o": ["Opción A", "Opción B", "Opción C"], "r": 2}
  ]
}
El campo "r" es el índice (0, 1 o 2) de la respuesta correcta dentro del arreglo "o".
Contenido: ${sourceText}`;

        const result = await model.generateContent(prompt);
        const textResponse = result.response.text();

        const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('La IA no devolvió JSON válido. Intenta de nuevo.');

        const data = JSON.parse(jsonMatch[0]);
        data.contexto = sourceText.substring(0, 8000);

        res.json(data);
    } catch (error) {
        console.error('Error en /api/estudiar:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── POST /api/chat
app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        if (!context || !question) {
            return res.status(400).json({ error: "Faltan los campos 'context' y/o 'question'." });
        }

        const prompt = `Eres un tutor amigable para estudiantes de secundaria y preparatoria. Basándote ÚNICAMENTE en el siguiente contexto, responde la pregunta del alumno de forma clara y sencilla. Si la pregunta no tiene relación con el tema, pídele amablemente que se enfoque en el contenido.

Contexto:
${context}

Pregunta del alumno:
${question}`;

        const result = await model.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        console.error('Error en /api/chat:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── GET / — verificar que el servidor vive
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '🚀 Tutor Backend activo y funcionando.' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en línea en el puerto ${PORT}`);
    console.log(`   Modelo: ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}`);
});
