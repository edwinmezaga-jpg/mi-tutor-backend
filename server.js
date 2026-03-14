import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFile, unlink } from 'fs/promises';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

if (!process.env.GEMINI_API_KEY)   console.error("⚠️  FALTA GEMINI_API_KEY");
if (!process.env.ELEVENLABS_API_KEY) console.warn("⚠️  FALTA ELEVENLABS_API_KEY — podcast desactivado");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Lee el modelo desde Render: GEMINI_MODEL=gemini-2.0-flash-lite
const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
    generationConfig: { responseMimeType: "application/json" }
});

// Modelo de chat (sin JSON forzado)
const chatModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
});

const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

// ── Lector Web
async function extraerTextoWeb(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('application/pdf')) {
            const data = await pdfParse(response.data);
            return data.text;
        } else if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const $ = cheerio.load(html);
            $('script, style, nav, footer, aside, header').remove();
            return $('h1, h2, h3, p, li').text().replace(/\s+/g, ' ').trim();
        }
        return response.data.toString('utf-8');
    } catch {
        throw new Error("El sitio web bloqueó la lectura. Por favor, copia y pega el texto directamente.");
    }
}

// ── Procesador IA
async function procesarConIA(sourceText) {
    if (!sourceText || sourceText.length < 50)
        throw new Error("No se encontró suficiente texto para analizar.");

    const prompt = `
Actúa como un tutor experto. Crea una clase detallada y didáctica en español.
Usa <br> para saltos de párrafo y <b> para conceptos importantes.

Devuelve ÚNICAMENTE este JSON sin ningún texto extra:
{
  "titulo": "Título claro de la clase",
  "resumen": "Clase magistral completa con formato HTML usando <b> y <br>",
  "quiz": [
    {"p": "Pregunta 1", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0},
    {"p": "Pregunta 2", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 1},
    {"p": "Pregunta 3", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2},
    {"p": "Pregunta 4", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 3},
    {"p": "Pregunta 5", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0}
  ],
  "flashcards": [
    {"anverso": "Concepto 1", "reverso": "Definición corta 1"},
    {"anverso": "Concepto 2", "reverso": "Definición corta 2"},
    {"anverso": "Concepto 3", "reverso": "Definición corta 3"},
    {"anverso": "Concepto 4", "reverso": "Definición corta 4"},
    {"anverso": "Concepto 5", "reverso": "Definición corta 5"}
  ]
}

Contenido: ${sourceText.substring(0, 30000)}`;

    const result = await model.generateContent(prompt);
    const data = JSON.parse(result.response.text());
    data.contexto = sourceText.substring(0, 10000);
    return data;
}

// ── RUTAS

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        let texto = input.trim();
        if (texto.startsWith('http')) texto = await extraerTextoWeb(texto);
        res.json(await procesarConIA(texto));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) throw new Error('No se recibió archivo.');
        const buf = await readFile(tmpPath);
        const texto = req.file.mimetype === 'application/pdf'
            ? (await pdfParse(buf)).text
            : buf.toString('utf-8');
        res.json(await procesarConIA(texto));
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (tmpPath) await unlink(tmpPath).catch(() => {});
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const prompt = `Contexto de la clase:\n${context}\n\nResponde como tutor amable: ${question}`;
        const result = await chatModel.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Podcast ElevenLabs
app.post('/api/podcast', async (req, res) => {
    try {
        const { texto } = req.body;
        if (!texto) return res.status(400).json({ error: "Falta el texto." });
        if (!process.env.ELEVENLABS_API_KEY)
            return res.status(500).json({ error: "Falta ELEVENLABS_API_KEY." });

        const textoLimpio = texto
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 2500);

        const VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel — multilingual

        const response = await axios.post(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
            {
                text: textoLimpio,
                model_id: 'eleven_multilingual_v2',
                voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.3 }
            },
            {
                headers: {
                    'xi-api-key': process.env.ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg'
                },
                responseType: 'arraybuffer',
                timeout: 30000
            }
        );

        res.set('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(response.data));
    } catch (e) {
        const msg = e.response?.data ? Buffer.from(e.response.data).toString() : e.message;
        res.status(500).json({ error: msg });
    }
});

app.listen(PORT, () => console.log(`🚀 Tutor IA activo en puerto ${PORT} — modelo: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'}`));
