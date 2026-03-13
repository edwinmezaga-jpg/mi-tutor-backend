const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { YoutubeTranscript } = require('youtube-transcript');
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

// ── Extrae texto: YouTube → subtítulos, lo demás → texto directo
async function obtenerTexto(input) {
    const esYoutube = /youtu\.be|youtube\.com/i.test(input);
    if (!esYoutube) return input;

    try {
        let transcript;
        try {
            transcript = await YoutubeTranscript.fetchTranscript(input, { lang: 'es' });
        } catch {
            transcript = await YoutubeTranscript.fetchTranscript(input, { lang: 'en' });
        }
        if (!transcript || transcript.length === 0) {
            throw new Error('Transcripción vacía.');
        }
        return transcript.map(item => item.text).join(' ');
    } catch (e) {
        throw new Error('No se pudo extraer la transcripción. (Sin subtítulos o video privado).');
    }
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

