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

// ── Verificación de llaves
if (!process.env.GEMINI_API_KEY) {
    console.error("⚠️ FALTA GEMINI_API_KEY en Render");
}
if (!process.env.GEMINI_API_KEY_IMAGEN) {
    console.warn("⚠️ FALTA GEMINI_API_KEY_IMAGEN");
}

// ── Clientes Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelTexto = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const genAIImagen = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_IMAGEN || process.env.GEMINI_API_KEY || '');
const modelImagen = genAIImagen.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
});

// ── Configuración para subir archivos
const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo imágenes (JPG, PNG) o PDF.'));
    }
});

async function archivoABase64(path, mimetype) {
    const buffer = await readFile(path);
    return { data: buffer.toString('base64'), mimeType: mimetype };
}

// ── 🌐 Scraper: Extrae texto real de las webs con Disfraz
async function extraerTextoWeb(url) {
    try {
        console.log(`🌐 Descargando contenido de: ${url}`);
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
            }
        });
        
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
        throw new Error(`El sitio web bloqueó la lectura o no existe.`);
    }
}

async function procesarEntrada(input) {
    const texto = input.trim();
    if (texto.startsWith('http://') || texto.startsWith('https://')) {
        return await extraerTextoWeb(texto);
    }
    return texto;
}

// ── Generar Ilustraciones Educativas
async function generarImagenExplicativa(titulo, resumen) {
    try {
        const prompt = `Crea una ilustración educativa, colorida y clara sobre el tema: "${titulo}". Estilo libro de texto moderno. Basado en: ${resumen.substring(0, 300)}`;
        const result = await modelImagen.generateContent(prompt);
        for (const part of result.response.candidates[0].content.parts) {
            if (part.inlineData) return { data: part.inlineData.data, mimeType: part.inlineData.mimeType };
        }
        return null;
    } catch (e) {
        console.error('Error generando imagen:', e.message);
        return null;
    }
}

// ── El Cerebro Blindado (JSON Perfecto)
async function procesarConIA(sourceText) {
    if (!sourceText || sourceText.length < 20) {
        throw new Error("El texto extraído es demasiado corto o está vacío.");
    }

    const prompt = `Actúa como un tutor experto. Analiza el contenido y responde ÚNICAMENTE con JSON.
⚠️ REGLAS CRÍTICAS:
1. NO uses comillas dobles (") dentro de los textos. Si debes citar, usa comillas simples (').
2. NO incluyas saltos de línea reales (Enters). Usa <br> para separar párrafos.
3. NO incluyas bloques markdown (como \`\`\`json).

{
  "titulo": "Título atractivo",
  "resumen": "Clase magistral detallada, separada por <br><br>.",
  "quiz": [
    {"p": "Pregunta 1", "o": ["Opcion A", "Opcion B", "Opcion C"], "r": 0},
    {"p": "Pregunta 2", "o": ["Opcion A", "Opcion B", "Opcion C"], "r": 1},
    {"p": "Pregunta 3", "o": ["Opcion A", "Opcion B", "Opcion C"], "r": 2}
  ]
}
Contenido a analizar: ${sourceText.substring(0, 30000)}`;

    const result = await modelTexto.generateContent(prompt);
    const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('La IA no devolvió un formato reconocible.');

    let data;
    try {
        data = JSON.parse(jsonMatch[0]);
    } catch (error) {
        throw new Error("La IA generó un formato incompatible. Por favor intenta de nuevo.");
    }

    data.contexto = sourceText.substring(0, 8000);

    console.log('🎨 Generando imagen...');
    const imagen = await generarImagenExplicativa(data.titulo, data.resumen);
    if (imagen) {
        data.imagen = `data:${imagen.mimeType};base64,${imagen.data}`;
    }

    return data;
}

// ── RUTAS DEL SERVIDOR ──

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        const textoReal = await procesarEntrada(input);
        const resultado = await procesarConIA(textoReal);
        res.json(resultado);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió archivo.' });
        let sourceText = '';

        if (req.file.mimetype === 'application/pdf') {
            const { data, mimeType } = await archivoABase64(tmpPath, 'application/pdf');
            const result = await modelTexto.generateContent([
                { inlineData: { data, mimeType } },
                { text: 'Extrae TODO el texto de este PDF.' }
            ]);
            sourceText = result.response.text();
        } else {
            const { data, mimeType } = await archivoABase64(tmpPath, req.file.mimetype);
            const result = await modelTexto.generateContent([
                { inlineData: { data, mimeType } },
                { text: 'Extrae TODO el texto visible.' }
            ]);
            sourceText = result.response.text();
        }

        const resultado = await procesarConIA(sourceText);
        res.json(resultado);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (tmpPath) await unlink(tmpPath).catch(() => {});
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const prompt = `Contexto: ${context}\nPregunta: ${question}`;
        const result = await modelTexto.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '🚀 Tutor Backend activo y funcionando.' });
});

app.listen(PORT, () => console.log(`🚀 Servidor en línea en el puerto ${PORT}`));
