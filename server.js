import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Innertube, UniversalCache } from 'youtubei.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
    console.error("⚠️  FALTA GEMINI_API_KEY en Render → Environment");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest'
});

// Inicializar YouTube una sola vez al arrancar el servidor
let youtube;
(async () => {
    youtube = await Innertube.create({
        cache: new UniversalCache(true)
    });
    console.log('✅ Innertube listo');
})();

// ── Saca el video ID de cualquier formato de URL de YouTube
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

// ── Obtiene subtítulos con youtubei.js
async function obtenerSubtitulosYouTube(videoId) {
    if (!youtube) throw new Error('El cliente de YouTube aún está iniciando, intenta en unos segundos.');

    const info = await youtube.getInfo(videoId);
    const transcriptData = await info.getTranscript();

    const segments = transcriptData?.transcript?.content?.body?.initial_segments;
    if (!segments || segments.length === 0) {
        throw new Error('Este video no tiene subtítulos disponibles.');
    }

    const texto = segments
        .map(s => s?.snippet?.text || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!texto) throw new Error('Los subtítulos estaban vacíos.');
    return texto;
}

// ── Decide si es YouTube o texto directo
async function obtenerTexto(input) {
    const esYoutube = /youtu\.be|youtube\.com/i.test(input);
    if (!esYoutube) return input;

    const videoId = extraerVideoId(input);
    if (!videoId) throw new Error('No se pudo leer el ID del video. Verifica el link.');

    console.log(`📺 Procesando video: ${videoId}`);
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
    console.log(`   Modelo: ${process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest'}`);
});
