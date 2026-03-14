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
            content: `Crea una clase didáctica en español sobre el siguiente contenido.
Usa <br> para saltos de párrafo y <b> para conceptos importantes en el resumen.

Devuelve EXACTAMENTE este JSON:
{
  "titulo": "Título claro de la clase",
  "resumen": "Clase magistral completa con <b>negritas</b> y <br> para párrafos",
  "quiz": [
    {"p": "Pregunta 1", "o": ["A", "B", "C", "D"], "r": 0},
    {"p": "Pregunta 2", "o": ["A", "B", "C", "D"], "r": 1},
    {"p": "Pregunta 3", "o": ["A", "B", "C", "D"], "r": 2},
    {"p": "Pregunta 4", "o": ["A", "B", "C", "D"], "r": 3},
    {"p": "Pregunta 5", "o": ["A", "B", "C", "D"], "r": 0}
  ],
  "flashcards": [
    {"anverso": "Concepto 1", "reverso": "Definición 1"},
    {"anverso": "Concepto 2", "reverso": "Definición 2"},
    {"anverso": "Concepto 3", "reverso": "Definición 3"},
    {"anverso": "Concepto 4", "reverso": "Definición 4"},
    {"anverso": "Concepto 5", "reverso": "Definición 5"}
  ]
}

Contenido: ${sourceText.substring(0, 28000)}`
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

        const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

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

app.listen(PORT, () => console.log(`🚀 Tutor IA activo en puerto ${PORT} — modelo: ${GROQ_MODEL}`));
