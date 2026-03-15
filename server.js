import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFile, unlink } from 'fs/promises';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import mongoose from 'mongoose';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

if (!process.env.GROQ_API_KEY)   console.error("⚠️  FALTA GROQ_API_KEY");
if (!process.env.MONGODB_URI)    console.warn("⚠️  FALTA MONGODB_URI — comprobantes desactivados");

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ══ MONGODB ══
// Conectar solo si hay URI configurada
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ MongoDB conectado'))
        .catch(e => console.error('❌ MongoDB error:', e.message));
}

// ── Esquema de Comprobante
const comprobanteSchema = new mongoose.Schema({
    shortId:   { type: String, unique: true, index: true },  // ID corto para URL: "A3X9K2"
    nombre:    String,
    titulo:    String,
    fecha:     String,
    hora:      String,
    correctas: Number,
    total:     Number,
    pct:       Number,
    codigo:    String,
    grupo:     String,   // opcional: código de grupo del maestro
    creadoEn:  { type: Date, default: Date.now }
});

// Esquema de Clase compartida
const claseSchema = new mongoose.Schema({
    shortId: { type: String, unique: true, index: true },
    titulo:  String,
    data:    Object,     // JSON completo de la clase
    vistas:  { type: Number, default: 0 },
    creadoEn: { type: Date, default: Date.now }
});

const Comprobante = mongoose.models.Comprobante || mongoose.model('Comprobante', comprobanteSchema);
const Clase = mongoose.models.Clase || mongoose.model('Clase', claseSchema);

// ── Generar ID corto único (6 caracteres alfanuméricos)
function generarShortId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres confusos
    return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}

async function shortIdUnico(Model) {
    let id, exists = true;
    while (exists) {
        id = generarShortId();
        exists = await Model.findOne({ shortId: id });
    }
    return id;
}

// ── Groq
async function groqCall(messages, jsonMode = false) {
    const body = { model: GROQ_MODEL, messages, temperature: 0.7, max_tokens: 4096 };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        body,
        {
            headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
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
            responseType: 'arraybuffer', timeout: 15000,
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
        { role: 'system', content: `Eres un tutor experto. Respondes ÚNICAMENTE con JSON válido, sin texto extra, sin markdown, sin bloques de código.` },
        { role: 'user', content: `Eres un profesor universitario experto. Crea una clase magistral COMPLETA y MUY DETALLADA en español sobre el siguiente contenido.

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
    {"p": "Pregunta 1", "o": ["A", "B", "C", "D"], "r": 0},
    {"p": "Pregunta 2", "o": ["A", "B", "C", "D"], "r": 1},
    {"p": "Pregunta 3", "o": ["A", "B", "C", "D"], "r": 2},
    {"p": "Pregunta 4", "o": ["A", "B", "C", "D"], "r": 3},
    {"p": "Pregunta 5", "o": ["A", "B", "C", "D"], "r": 0},
    {"p": "Pregunta 6", "o": ["A", "B", "C", "D"], "r": 1}
  ],
  "flashcards": [
    {"anverso": "Concepto 1", "definicion": "Qué es en una oración clara", "contexto": "Cómo se usa con ejemplo concreto"},
    {"anverso": "Concepto 2", "definicion": "Qué es en una oración clara", "contexto": "Cómo se usa con ejemplo concreto"},
    {"anverso": "Concepto 3", "definicion": "Qué es en una oración clara", "contexto": "Cómo se usa con ejemplo concreto"},
    {"anverso": "Concepto 4", "definicion": "Qué es en una oración clara", "contexto": "Cómo se usa con ejemplo concreto"},
    {"anverso": "Concepto 5", "definicion": "Qué es en una oración clara", "contexto": "Cómo se usa con ejemplo concreto"},
    {"anverso": "Concepto 6", "definicion": "Qué es en una oración clara", "contexto": "Cómo se usa con ejemplo concreto"}
  ]
}

Contenido a enseñar: ${sourceText.substring(0, 28000)}` }
    ];

    const text = await groqCall(messages, true);
    const data = JSON.parse(text);
    data.contexto = sourceText.substring(0, 10000);
    return data;
}

// ══ RUTAS EXISTENTES ══

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        let texto = input.trim();
        if (texto.startsWith('http')) texto = await extraerTextoWeb(texto);
        res.json(await procesarConIA(texto));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió archivo.' });
        const buf = await readFile(tmpPath);
        const mime = req.file.mimetype;
        let sourceText = '';

        if (mime === 'application/pdf') {
            try { const data = await pdfParse(buf); sourceText = data.text; }
            catch(e) { throw new Error('No se pudo leer el PDF. Verifica que no esté protegido.'); }
        } else if (mime.startsWith('image/')) {
            const base64 = buf.toString('base64');
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                    messages: [{ role: 'user', content: [
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
                        { type: 'text', text: 'Transcribe y describe todo el texto e información que ves en esta imagen. Sé exhaustivo.' }
                    ]}],
                    max_tokens: 4096
                },
                { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
            );
            sourceText = response.data.choices[0].message.content;
        } else {
            sourceText = buf.toString('utf-8');
        }

        if (!sourceText || sourceText.trim().length < 30)
            throw new Error('No se encontró suficiente texto. Intenta con otro formato.');

        res.json(await procesarConIA(sourceText));
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (tmpPath) await unlink(tmpPath).catch(() => {}); }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const messages = [
            { role: 'system', content: 'Eres un tutor amable y claro. Responde en español de forma concisa.' },
            { role: 'user', content: `Contexto:\n${context}\n\nDuda: ${question}` }
        ];
        const answer = await groqCall(messages);
        res.json({ answer });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ RUTAS NUEVAS CON MONGODB ══

// 1. Guardar comprobante y devolver shortId
app.post('/api/comprobante', async (req, res) => {
    try {
        if (!mongoose.connection.readyState)
            return res.status(503).json({ error: 'Base de datos no disponible.' });

        const { nombre, titulo, fecha, hora, correctas, total, pct, codigo, grupo } = req.body;
        if (!nombre || !titulo) return res.status(400).json({ error: 'Faltan datos.' });

        const shortId = await shortIdUnico(Comprobante);
        await Comprobante.create({ shortId, nombre, titulo, fecha, hora, correctas, total, pct, codigo, grupo: grupo || '' });

        res.json({ shortId, url: `/verificar/${shortId}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Verificar comprobante por shortId
app.get('/api/verificar/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState)
            return res.status(503).json({ error: 'Base de datos no disponible.' });

        const comp = await Comprobante.findOne({ shortId: req.params.shortId });
        if (!comp) return res.status(404).json({ error: 'Comprobante no encontrado.' });
        res.json(comp);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Guardar clase y devolver shortId para link corto
app.post('/api/clase', async (req, res) => {
    try {
        if (!mongoose.connection.readyState)
            return res.status(503).json({ error: 'Base de datos no disponible.' });

        const { titulo, data } = req.body;
        if (!titulo || !data) return res.status(400).json({ error: 'Faltan datos.' });

        const shortId = await shortIdUnico(Clase);
        await Clase.create({ shortId, titulo, data });
        res.json({ shortId, url: `${process.env.APP_URL || ''}/c/${shortId}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Cargar clase por shortId (para links cortos /c/ABC123)
app.get('/api/clase/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState)
            return res.status(503).json({ error: 'Base de datos no disponible.' });

        const clase = await Clase.findOneAndUpdate(
            { shortId: req.params.shortId },
            { $inc: { vistas: 1 } },
            { new: true }
        );
        if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });
        res.json(clase.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Dashboard del maestro — ver todos los comprobantes de un grupo
app.get('/api/dashboard/:grupo', async (req, res) => {
    try {
        if (!mongoose.connection.readyState)
            return res.status(503).json({ error: 'Base de datos no disponible.' });

        const comprobantes = await Comprobante
            .find({ grupo: req.params.grupo })
            .sort({ creadoEn: -1 })
            .select('-__v');
        res.json({ grupo: req.params.grupo, total: comprobantes.length, comprobantes });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Tutor IA activo en puerto ${PORT} — modelo: ${GROQ_MODEL}`));
