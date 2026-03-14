import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFile, unlink } from 'fs/promises';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

if (!process.env.GROQ_API_KEY)       console.error("⚠️  FALTA GROQ_API_KEY");
if (!process.env.ELEVENLABS_API_KEY) console.warn("⚠️  FALTA ELEVENLABS_API_KEY");

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ── Llamada a Groq
async function groqCall(messages, jsonMode = false) {
    const body = {
        model: GROQ_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 4096
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        body,
        {
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        }
    );
    return response.data.choices[0].message.content;
}

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

    const messages = [
        {
            role: 'system',
            content: `Eres un tutor experto. Respondes ÚNICAMENTE con JSON válido, sin texto extra, sin markdown, sin bloques de código.`
        },
        {
            role: 'user',
            content: `Eres un profesor universitario experto. Crea una clase magistral COMPLETA y MUY DETALLADA en español sobre el siguiente contenido.

INSTRUCCIONES PARA EL RESUMEN:
- Mínimo 5 párrafos largos y bien desarrollados
- Explica cada concepto con profundidad, ejemplos y contexto
- Usa <br><br> entre párrafos y <b>negritas</b> para conceptos clave
- No hagas listas, escribe como una clase magistral fluida
- El alumno debe quedar con una comprensión profunda del tema

Devuelve EXACTAMENTE este JSON sin texto extra:
{
  "titulo": "Título específico y descriptivo de la clase",
  "resumen": "Clase magistral muy detallada con mínimo 5 párrafos usando <b>negritas</b> y <br><br> entre párrafos",
  "quiz": [
    {"p": "Pregunta 1 sobre concepto importante", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 0},
    {"p": "Pregunta 2 sobre concepto importante", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 1},
    {"p": "Pregunta 3 sobre concepto importante", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 2},
    {"p": "Pregunta 4 sobre concepto importante", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 3},
    {"p": "Pregunta 5 sobre concepto importante", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 0}
  ],
  "flashcards": [
    {"anverso": "Concepto clave 1", "definicion": "Qué es en una oración clara y directa", "contexto": "Cómo se usa, para qué sirve o en qué situación aparece este concepto, con un ejemplo concreto del tema."},
    {"anverso": "Concepto clave 2", "definicion": "Qué es en una oración clara y directa", "contexto": "Cómo se usa, para qué sirve o en qué situación aparece este concepto, con un ejemplo concreto del tema."},
    {"anverso": "Concepto clave 3", "definicion": "Qué es en una oración clara y directa", "contexto": "Cómo se usa, para qué sirve o en qué situación aparece este concepto, con un ejemplo concreto del tema."},
    {"anverso": "Concepto clave 4", "definicion": "Qué es en una oración clara y directa", "contexto": "Cómo se usa, para qué sirve o en qué situación aparece este concepto, con un ejemplo concreto del tema."},
    {"anverso": "Concepto clave 5", "definicion": "Qué es en una oración clara y directa", "contexto": "Cómo se usa, para qué sirve o en qué situación aparece este concepto, con un ejemplo concreto del tema."},
    {"anverso": "Concepto clave 6", "definicion": "Qué es en una oración clara y directa", "contexto": "Cómo se usa, para qué sirve o en qué situación aparece este concepto, con un ejemplo concreto del tema."}
  ]
}

Contenido a enseñar: ${sourceText.substring(0, 28000)}`
        }
    ];

    const text = await groqCall(messages, true);
    const data = JSON.parse(text);
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
        const messages = [
            { role: 'system', content: 'Eres un tutor amable y claro. Responde en español de forma concisa.' },
            { role: 'user', content: `Contexto de la clase:\n${context}\n\nDuda del alumno: ${question}` }
        ];
        const answer = await groqCall(messages);
        res.json({ answer });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Tutor IA activo en puerto ${PORT} — modelo: ${GROQ_MODEL}`));
