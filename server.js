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
    console.error("⚠️ FALTAN LAS LLAVES DE GEMINI EN RENDER");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

async function obtenerTexto(input) {
    const esYoutube = /youtu\.be|youtube\.com/i.test(input);
    if (!esYoutube) return input;

    try {
        const transcript = await YoutubeTranscript.fetchTranscript(input, { lang: 'es' })
            .catch(() => YoutubeTranscript.fetchTranscript(input, { lang: 'en' }));
        return transcript.map(item => item.text).join(' ');
    } catch (e) {
        throw new Error('No se pudo extraer la transcripción del video. (Quizá no tiene subtítulos).');
    }
}

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido" });

        const sourceText = await obtenerTexto(input);

        const prompt = `Actúa como un tutor experto. Analiza el siguiente contenido y responde ÚNICAMENTE con formato JSON estricto:
        {
          "titulo": "Título de la clase",
          "resumen": "Resumen de 3 párrafos",
          "quiz": [
            {"p": "Pregunta", "o": ["A", "B", "C"], "r": 0}
          ]
        }
        Contenido: ${sourceText}`;

        const result = await model.generateContent(prompt);
        const textResponse = result.response.text();
        
        const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("La IA no devolvió JSON válido.");

        const data = JSON.parse(jsonMatch[0]);
        data.contexto = sourceText;

        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const prompt = `Contexto: ${context}\n\nPregunta: ${question}`;
        const result = await model.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor BLINDADO en línea en el puerto ${PORT}`));
