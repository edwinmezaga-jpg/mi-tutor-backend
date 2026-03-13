import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { YoutubeTranscript } from 'youtube-transcript';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// Configuración de CORS para que tu HostGator pueda hablar con Render
app.use(cors());
app.use(express.json());

// Inicialización de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

// Función mágica para leer YouTube
async function obtenerTexto(input) {
    const esYoutube = /youtu\.be|youtube\.com/i.test(input);
    if (!esYoutube) return input;

    try {
        const transcript = await YoutubeTranscript.fetchTranscript(input, { lang: 'es' })
            .catch(() => YoutubeTranscript.fetchTranscript(input, { lang: 'en' }));
        return transcript.map(item => item.text).join(' ');
    } catch (e) {
        throw new Error('No se pudo obtener la transcripción del video. Asegúrate de que tenga subtítulos habilitados.');
    }
}

// Ruta principal: Procesa el link o texto
app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "No enviaste contenido" });

        const sourceText = await obtenerTexto(input);

        const prompt = `Actúa como un tutor experto. Analiza el siguiente contenido y responde ÚNICAMENTE con un objeto JSON (sin bloques de código markdown):
        {
          "titulo": "Título breve",
          "resumen": "Resumen de 3 párrafos explicando los puntos clave",
          "quiz": [
            {"p": "Pregunta 1", "o": ["Opción A", "Opción B", "Opción C"], "r": 0}
          ]
        }
        Contenido a procesar: ${sourceText}`;

        const result = await model.generateContent(prompt);
        const textResponse = result.response.text();
        
        // Limpiamos la respuesta por si Gemini agrega ```json
        const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Respuesta de IA no válida");

        const data = JSON.parse(jsonMatch[0]);
        data.contexto = sourceText; // Guardamos el texto para el chat posterior

        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Ruta del Chat: Responde preguntas de seguimiento
app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const prompt = `Contexto: ${context}\n\nPregunta del estudiante: ${question}`;
        const result = await model.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor volando en puerto ${PORT}`));