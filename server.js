import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFile, unlink } from 'fs/promises';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Innertube, UniversalCache } from 'youtubei.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ── Clientes de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelTexto = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── 1. Función para extraer texto de sitios web y PDFs por URL
async function extraerTextoWeb(url) {
    try {
        console.log(`Descargando contenido real de: ${url}`);
        // Descargamos la web o el pdf
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || '';

        // Si es un PDF
        if (contentType.includes('application/pdf')) {
            const data = await pdfParse(response.data);
            return data.text;
        } 
        // Si es una página web (HTML)
        else if (contentType.includes('text/html')) {
            const html = response.data.toString('utf-8');
            const $ = cheerio.load(html);
            
            // Eliminamos menús, anuncios, scripts y estilos para dejar solo el texto útil
            $('script, style, nav, footer, aside, header, noscript').remove();
            
            // Extraemos el texto de los títulos y párrafos
            const textoLimpio = $('h1, h2, h3, p, li, article, section').text().replace(/\s+/g, ' ').trim();
            return textoLimpio;
        } else {
            return response.data.toString('utf-8');
        }
    } catch (error) {
        console.error("Error al leer la URL:", error.message);
        throw new Error("No se pudo leer el contenido del sitio web. El sitio podría estar bloqueando el acceso o el link es inválido.");
    }
}

// ── 2. Función para YouTube
function esYoutubeUrl(url) {
    return /youtu\.be\/|youtube\.com\/(?:.*v=|.*\/|.*v\/)/i.test(url);
}

function extraerVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:.*v=|.*\/|.*v\/))([^"&?\/\s]{11})/);
    return match ? match[1] : null;
}

async function obtenerTextoDeYouTube(input) {
    const videoId = extraerVideoId(input);
    const yt = await Innertube.create({ cache: new UniversalCache(false), generate_session_locally: true });
    const info = await yt.getBasicInfo(videoId, { client: 'WEB' }); 
    const transcriptData = await info.getTranscript();
    if (!transcriptData || !transcriptData.transcript) throw new Error("El video no tiene subtítulos.");
    
    return transcriptData.transcript.content.body.initial_segments.map(s => s.snippet.text).join(' ');
}

// ── 3. Procesador Central (El cerebro que decide qué leer)
async function procesarEntrada(input) {
    const textoIngresado = input.trim();

    // Caso A: Es un link de YouTube
    if (esYoutubeUrl(textoIngresado)) {
        return await obtenerTextoDeYouTube(textoIngresado);
    }
    // Caso B: Es un link de cualquier otro sitio web o PDF (empieza con http o https)
    else if (textoIngresado.startsWith('http://') || textoIngresado.startsWith('https://')) {
        return await extraerTextoWeb(textoIngresado);
    }
    // Caso C: Es texto puro pegado por el usuario
    else {
        return textoIngresado;
    }
}

// ── RUTAS

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido" });

        // Aquí el backend lee la información real antes de enviarla a Gemini
        const sourceText = await procesarEntrada(input);

        const prompt = `Actúa como un tutor experto. Analiza el siguiente contenido y responde ÚNICAMENTE con formato JSON estricto:
        {
          "titulo": "Título de la clase",
          "resumen": "Resumen detallado de la información proporcionada",
          "quiz": [
            {"p": "Pregunta", "o": ["A", "B", "C"], "r": 0}
          ]
        }
        Contenido real a analizar: ${sourceText.substring(0, 30000)}`; // Limitamos el texto a 30k caracteres para no saturar a Gemini

        const result = await modelTexto.generateContent(prompt);
        const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("La IA no devolvió JSON válido.");

        const data = JSON.parse(jsonMatch[0]);
        data.contexto = sourceText.substring(0, 15000); // Guardamos el contexto para el chat

        res.json(data);
    } catch (error) {
        console.error("Error en /api/estudiar:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── Rutas de archivos y chat que ya tenías
const upload = multer({ dest: '/tmp/' });
app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    let tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
        const mimetype = req.file.mimetype;
        const fileBuffer = await readFile(tmpPath);
        let textExtracted = "";

        if (mimetype === 'application/pdf') {
            const data = await pdfParse(fileBuffer);
            textExtracted = data.text;
        } else if (mimetype === 'text/plain') {
            textExtracted = fileBuffer.toString('utf-8');
        } else {
            return res.status(400).json({ error: 'Formato no soportado (solo PDF y TXT).' });
        }

        const prompt = `Actúa como tutor. Analiza este contenido y responde SOLO en JSON con "titulo", "resumen" y un "quiz" de 3 preguntas con "p", "o" (arreglo de 3) y "r" (índice 0-2).\n\nContenido: ${textExtracted.substring(0, 30000)}`;
        
        const result = await modelTexto.generateContent(prompt);
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
        const prompt = `Eres un tutor. Usa SOLO el contexto para responder. Contexto: ${context}\n\nPregunta: ${question}`;
        const result = await modelTexto.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor en línea en el puerto ${PORT}`));
