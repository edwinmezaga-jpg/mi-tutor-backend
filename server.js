import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
// CAMBIO AQUÍ: Quitamos las llaves { } para que funcione correctamente
import YoutubeTranscript from 'youtube-transcript'; 
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
// Usamos gemini-1.5-flash-latest como acordamos
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

async function obtenerTexto(input) {
    const esYoutube = /youtu\.be|youtube\.com/i.test(input);
    if (!esYoutube) return input;

    try {
        // La llamada a la función se mantiene igual
        const transcript = await YoutubeTranscript.fetchTranscript(input, { lang: 'es' })
            .catch(() => YoutubeTranscript.fetchTranscript(input, { lang: 'en' }));
        return transcript.map(item => item.text).join(' ');
    } catch (e) {
        throw new Error('No se pudo obtener la transcripción. ¿El video tiene subtítulos?');
    }
}

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "No enviaste contenido" });

        const sourceText = await obtenerTexto(input);

        const prompt = `Actúa como un tutor experto. Analiza el contenido y responde ÚNICAMENTE con un JSON:
        {
          "titulo": "Título breve",
          "resumen": "Resumen de 3 párrafos",
          "quiz": [{"p": "Pregunta 1", "o": ["Opción A", "Opción B", "Opción C"], "r": 0}]
        }
        Contenido: ${sourceText}`;

        const result = await model.generateContent(prompt);
        const textResponse = result.response.text();
        const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
        
        if (!jsonMatch) throw new Error("Respuesta de IA no válida");

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

app.listen(PORT, () => console.log(`🚀 Servidor volando en puerto ${PORT}`));
