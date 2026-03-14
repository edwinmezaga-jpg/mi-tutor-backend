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

if (!process.env.GEMINI_API_KEY) {
    console.error("⚠️  FALTA GEMINI_API_KEY en Render → Environment");
}
if (!process.env.GEMINI_API_KEY_IMAGEN) {
    console.warn("⚠️  FALTA GEMINI_API_KEY_IMAGEN — las imágenes no se generarán");
}

// ── Cliente texto
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelTexto = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
});

// ── Cliente imagen
const genAIImagen = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY_IMAGEN || process.env.GEMINI_API_KEY || ''
);
const modelImagen = genAIImagen.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
});

const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se permiten imágenes o PDF.'));
    }
});

async function archivoABase64(path, mimetype) {
    const buffer = await readFile(path);
    return { data: buffer.toString('base64'), mimeType: mimetype };
}

// ── 🌐 Lector REAL de Sitios Web con "Disfraz Humano"
async function extraerTextoWeb(url) {
    try {
        console.log(`🌐 Descargando contenido de: ${url}`);
        
        // El disfraz de Google Chrome para que Wikipedia y otros no nos bloqueen
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
        console.error("Error al extraer texto web:", error.message);
        throw new Error(`El sitio web bloqueó la lectura o no existe. Detalle: ${error.message}`);
    }
}

async function procesarEntrada(input) {
    const texto = input.trim();
    if (texto.startsWith('http://') || texto.startsWith('https://')) {
        return await extraerTextoWeb(texto);
    }
    return texto;
}

async function generarImagenExplicativa(titulo, resumen) {
    try {
        const prompt = `Crea una ilustración educativa, colorida y clara sobre el tema: "${titulo}". 
El estilo debe ser como el de un libro de texto moderno para estudiantes de secundaria: 
diagramas simples, iconos, flechas explicativas, colores vivos. 
Basado en: ${resumen.substring(0, 300)}`;

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

async function procesarConIA(sourceText) {
    if (!sourceText || sourceText.length < 20) {
        throw new Error("El texto extraído es demasiado corto o está vacío.");
    }

    const prompt = `Actúa como un tutor experto para estudiantes de secundaria y preparatoria.
Analiza el siguiente contenido y responde ÚNICAMENTE con un JSON válido, sin texto extra antes ni después, sin bloques de código markdown:
{
  "titulo": "Título claro del tema",
  "resumen": "Clase magistral detallada, explicativa y didáctica usando lenguaje sencillo, separados por saltos de línea (<br><br>)",
  "quiz": [
    {"p": "Pregunta 1", "o": ["Opción A", "Opción B", "Opción C"], "r": 0},
    {"p": "Pregunta 2", "o": ["Opción A", "Opción B", "Opción C"], "r": 1},
    {"p": "Pregunta 3", "o": ["Opción A", "Opción B", "Opción C"], "r": 2}
  ]
}
El campo "r" es el índice (0, 1 o 2) de la respuesta correcta dentro del arreglo "o".
Contenido REAL a analizar: ${sourceText.substring(0, 30000)}`;

    const result = await modelTexto.generateContent(prompt);
    const textResponse = result.response.text();

    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('La IA no devolvió JSON válido. Intenta de nuevo.');

    const data = JSON.parse(jsonMatch[0]);
    data.contexto = sourceText.substring(0, 8000);

    console.log('🎨 Generando imagen...');
    const imagen = await generarImagenExplicativa(data.titulo, data.resumen);
    if (imagen) {
        data.imagen = `data:${imagen.mimeType};base64,${imagen.data}`;
    }

    return data;
}

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta el campo 'input'." });
        
        const textoRealExtraido = await procesarEntrada(input);
        const resultado = await procesarConIA(textoRealExtraido);
        
        res.json(resultado);
    } catch (error) {
        console.error('Error en /api/estudiar:', error.message);
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
                { text: 'Extrae TODO el texto visible en esta imagen.' }
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

app.listen(PORT, () => console.log(`🚀 Servidor en línea en el puerto ${PORT}`));
