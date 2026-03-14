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

// ── Cliente texto: gemini-2.5-flash
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelTexto = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
});

// ── Cliente imagen: gemini-2.5-flash-image
const genAIImagen = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY_IMAGEN || process.env.GEMINI_API_KEY || ''
);
const modelImagen = genAIImagen.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
});

// ── Multer — archivos temporales
const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se permiten imágenes (JPG, PNG, WEBP) o PDF.'));
    }
});

async function archivoABase64(path, mimetype) {
    const buffer = await readFile(path);
    return { data: buffer.toString('base64'), mimeType: mimetype };
}

// ── 🌐 NUEVO: Lector REAL de Sitios Web y PDFs (Scraper)
async function extraerTextoWeb(url) {
    try {
        console.log(`🌐 Descargando contenido real de: ${url}`);
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('application/pdf')) {
            const data = await pdfParse(response.data);
            return data.text;
        } else if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const $ = cheerio.load(html);
            // Quitamos basura visual de la página
            $('script, style, nav, footer, aside, header, noscript').remove();
            // Extraemos solo el texto de los párrafos y títulos
            return $('h1, h2, h3, p, li, article, section').text().replace(/\s+/g, ' ').trim();
        } else {
            return response.data.toString('utf-8');
        }
    } catch (error) {
        console.error("Error al extraer texto web:", error.message);
        throw new Error("No se pudo leer la página web. Intenta copiar y pegar el texto en lugar del link.");
    }
}

// Intercepta si es un link o es texto normal
async function procesarEntrada(input) {
    const texto = input.trim();
    if (texto.startsWith('http://') || texto.startsWith('https://')) {
        return await extraerTextoWeb(texto);
    }
    return texto;
}

// ── Genera imagen educativa
async function generarImagenExplicativa(titulo, resumen) {
    try {
        const prompt = `Crea una ilustración educativa, colorida y clara sobre el tema: "${titulo}". 
El estilo debe ser como el de un libro de texto moderno para estudiantes de secundaria: 
diagramas simples, iconos, flechas explicativas, colores vivos. 
Basado en: ${resumen.substring(0, 300)}`;

        const result = await modelImagen.generateContent(prompt);

        for (const part of result.response.candidates[0].content.parts) {
            if (part.inlineData) {
                return {
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType
                };
            }
        }
        return null;
    } catch (e) {
        console.error('Error generando imagen:', e.message);
        return null;
    }
}

// ── Función central con el texto REAL extraído
async function procesarConIA(sourceText) {
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

    console.log('🎨 Generando imagen con Nano Banana...');
    const imagen = await generarImagenExplicativa(data.titulo, data.resumen);
    if (imagen) {
        data.imagen = `data:${imagen.mimeType};base64,${imagen.data}`;
        console.log('✅ Imagen generada correctamente');
    }

    return data;
}

// ── POST /api/estudiar
app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta el campo 'input'." });
        
        // 🔴 AQUÍ OCURRE LA MAGIA: Tu servidor va a la página web y extrae el texto antes de llamar a Gemini
        const textoRealExtraido = await procesarEntrada(input);
        
        const resultado = await procesarConIA(textoRealExtraido);
        res.json(resultado);
    } catch (error) {
        console.error('Error en /api/estudiar:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── POST /api/estudiar-archivo (Intacto)
app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

        let sourceText = '';

        if (req.file.mimetype === 'application/pdf') {
            console.log('📄 Procesando PDF...');
            const { data, mimeType } = await archivoABase64(tmpPath, 'application/pdf');
            const result = await modelTexto.generateContent([
                { inlineData: { data, mimeType } },
                { text: 'Extrae y devuelve TODO el texto de este PDF tal como aparece, sin resumir ni modificar nada.' }
            ]);
            sourceText = result.response.text();
        } else {
            console.log('🖼️  Procesando imagen...');
            const { data, mimeType } = await archivoABase64(tmpPath, req.file.mimetype);
            const result = await modelTexto.generateContent([
                { inlineData: { data, mimeType } },
                { text: 'Extrae y devuelve TODO el texto visible en esta imagen tal como aparece, sin resumir ni modificar nada.' }
            ]);
            sourceText = result.response.text();
        }

        if (!sourceText || sourceText.trim().length < 20) {
            throw new Error('No se pudo extraer texto del archivo.');
        }

        const resultado = await procesarConIA(sourceText);
        res.json(resultado);

    } catch (error) {
        console.error('Error en /api/estudiar-archivo:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (tmpPath) await unlink(tmpPath).catch(() => {});
    }
});

// ── POST /api/chat
app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        if (!context || !question) return res.status(400).json({ error: "Faltan campos." });

        const prompt = `Eres un tutor amigable. Basándote ÚNICAMENTE en este contexto, responde:
Contexto: ${context}
Pregunta: ${question}`;

        const result = await modelTexto.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en línea en el puerto ${PORT}`);
});
