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
app.use(express.json());

// ── Cliente de Gemini
if (!process.env.GEMINI_API_KEY) {
    console.error("⚠️ FALTA GEMINI_API_KEY en Render");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelTexto = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── Función para extraer texto REAL de páginas web
async function extraerTextoWeb(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('application/pdf')) {
            const data = await pdfParse(response.data);
            return data.text;
        } else if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const $ = cheerio.load(html);
            $('script, style, nav, footer, aside, header, noscript').remove();
            return $('h1, h2, h3, p, li, article, section').text().replace(/\s+/g, ' ').trim();
        } else {
            return response.data.toString('utf-8');
        }
    } catch (error) {
        throw new Error("No se pudo extraer el texto de la página web. Intenta pegando el texto directamente.");
    }
}

async function procesarEntrada(input) {
    const texto = input.trim();
    if (texto.startsWith('http://') || texto.startsWith('https://')) {
        return await extraerTextoWeb(texto);
    }
    return texto;
}

// ── El Prompt "Chingón" (Didáctico y Detallado)
const PROMPT_TUTOR = `Eres el mejor profesor particular del mundo. Tu objetivo es hacer que conceptos complejos sean extremadamente fáciles de entender para un estudiante.
Analiza el siguiente contenido y responde ÚNICAMENTE con un formato JSON estricto.

Reglas para la "explicacion":
- No hagas un simple resumen. Explica el tema de forma profunda, paso a paso y didáctica.
- Usa analogías o ejemplos de la vida real.
- Formatea el texto usando etiquetas HTML básicas (<br><br> para separar párrafos, <b> para negritas, <ul><li> para listas) para que se vea hermoso y fácil de leer.

Estructura JSON requerida:
{
  "titulo": "Título atractivo de la lección",
  "explicacion": "Tu explicación magistral y detallada con HTML aquí...",
  "quiz": [
    {"p": "Pregunta 1 de comprensión", "o": ["Opción A", "Opción B", "Opción C"], "r": 0},
    {"p": "Pregunta 2 de análisis", "o": ["Opción A", "Opción B", "Opción C"], "r": 1},
    {"p": "Pregunta 3 de retención", "o": ["Opción A", "Opción B", "Opción C"], "r": 2}
  ]
}`;

// ── Rutas
app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido" });

        const sourceText = await procesarEntrada(input);
        const promptFinal = `${PROMPT_TUTOR}\n\nContenido a enseñar:\n${sourceText.substring(0, 30000)}`;

        const result = await modelTexto.generateContent(promptFinal);
        const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("La IA no devolvió JSON válido.");

        const data = JSON.parse(jsonMatch[0]);
        data.contexto = sourceText.substring(0, 15000); 

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const upload = multer({ dest: '/tmp/' });
app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    let tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No hay archivo.' });
        const fileBuffer = await readFile(tmpPath);
        let textExtracted = "";

        if (req.file.mimetype === 'application/pdf') {
            const data = await pdfParse(fileBuffer);
            textExtracted = data.text;
        } else {
            textExtracted = fileBuffer.toString('utf-8');
        }

        const promptFinal = `${PROMPT_TUTOR}\n\nContenido a enseñar:\n${textExtracted.substring(0, 30000)}`;
        const result = await modelTexto.generateContent(promptFinal);
        const data = JSON.parse(result.response.text().match(/\{[\s\S]*\}/)[0]);
        data.contexto = textExtracted.substring(0, 15000);
        
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (tmpPath) await unlink(tmpPath).catch(() => {});
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const prompt = `Eres un tutor. Responde de forma amigable y didáctica usando SOLO este contexto:\n${context}\n\nPregunta del alumno: ${question}`;
        const result = await modelTexto.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor en línea en el puerto ${PORT}`));
