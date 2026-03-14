const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash-latest"
});

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

// ── Obtiene los subtítulos scrapeando el HTML de YouTube directamente
async function obtenerSubtitulosYouTube(videoId) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    };

    // 1. Descargar la página del video
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
    if (!pageRes.ok) throw new Error(`YouTube devolvió status ${pageRes.status}`);
    const html = await pageRes.text();

    // 2. Buscar los captionTracks en el JSON embebido
    const captionMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (!captionMatch) {
        throw new Error('Este video no tiene subtítulos disponibles.');
    }

    let tracks;
    try {
        tracks = JSON.parse(captionMatch[1]);
    } catch {
        throw new Error('No se pudieron leer los subtítulos del video.');
    }

    if (!tracks || tracks.length === 0) {
        throw new Error('Este video no tiene subtítulos disponibles.');
    }

    // 3. Preferir español, luego inglés, luego el primero que haya
    const track =
        tracks.find(t => t.languageCode === 'es') ||
        tracks.find(t => t.languageCode === 'es-MX') ||
        tracks.find(t => t.languageCode === 'es-419') ||
        tracks.find(t => t.languageCode === 'en') ||
        tracks[0];

    console.log(`   Usando subtítulos: ${track.languageCode} — ${track.name?.simpleText || ''}`);

    // 4. Descargar el XML de subtítulos
    const xmlRes = await fetch(track.baseUrl, { headers });
    if (!xmlRes.ok) throw new Error(`Error al descargar subtítulos (status ${xmlRes.status})`);
    const xmlText = await xmlRes.text();

    // 5. Parsear el XML y extraer el texto
    const parsed = await xml2js.parseStringPromise(xmlText);
    const segments = parsed?.transcript?.text || [];

    const texto = segments
        .map(s => (typeof s === 'string' ? s : s._ || ''))
        .join(' ')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
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
        if (!jsonMatch) throw new Error("La IA no devolvió JSON válido. Intenta de nuevo.");

        const data = JSON.parse(jsonMatch[0]);
        data.contexto = sourceText.substring(0, 8000);

        res.json(data);
    } catch (error) {
        console.error("Error en /api/estudiar:", error.message);
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
        console.error("Error en /api/chat:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── GET / — verificar que el servidor vive
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '🚀 Tutor Backend activo y funcionando.' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en línea en el puerto ${PORT}`);
    console.log(`   Modelo: ${process.env.GEMINI_MODEL || "gemini-1.5-flash-latest"}`);
});
