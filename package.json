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
    console.error("⚠️ FALTA GEMINI_API_KEY");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// 💡 OBLIGAMOS a la IA a responder siempre en formato JSON perfecto
const model = genAI.getGenerativeModel({ 
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: "application/json" } 
});

const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

// ── 🌐 Lector Web Rápido con "Disfraz"
async function extraerTextoWeb(url) {
    try {
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
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
        } else {
            return response.data.toString('utf-8');
        }
    } catch (error) {
        throw new Error("El sitio web bloqueó la lectura. Por favor, copia y pega el texto directamente.");
    }
}

// ── Procesador de IA Ultrarrápido (Ahora con Flashcards)
async function procesarConIA(sourceText) {
    if (!sourceText || sourceText.length < 50) {
        throw new Error("No se encontró suficiente texto en el enlace o documento para analizar.");
    }

    const prompt = `
    Actúa como un tutor experto. Crea una clase detallada y didáctica.
    Usa etiquetas HTML como <br> para separar párrafos y <b> para negritas.
    
    Estructura JSON solicitada:
    {
      "titulo": "Título de la clase",
      "resumen": "Clase magistral profunda y bien explicada",
      "flashcards": [
        {"anverso": "Concepto Clave 1", "reverso": "Definición corta y fácil de recordar"},
        {"anverso": "Concepto Clave 2", "reverso": "Definición corta y fácil de recordar"},
        {"anverso": "Concepto Clave 3", "reverso": "Definición corta y fácil de recordar"}
      ],
      "quiz": [
        {"p": "Pregunta 1", "o": ["A", "B", "C"], "r": 0},
        {"p": "Pregunta 2", "o": ["A", "B", "C"], "r": 1},
        {"p": "Pregunta 3", "o": ["A", "B", "C"], "r": 2}
      ]
    }
    Contenido a enseñar: ${sourceText.substring(0, 35000)}`;

    const result = await model.generateContent(prompt);
    
    // Como activamos JSON nativo, podemos parsearlo directamente sin miedo
    const data = JSON.parse(result.response.text());
    data.contexto = sourceText.substring(0, 10000); 
    
    return data;
}

// ── RUTAS PRINCIPALES ──

app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        
        let textoReal = input.trim();
        if (textoReal.startsWith('http')) {
            textoReal = await extraerTextoWeb(textoReal);
        }
        
        const resultado = await procesarConIA(textoReal);
        res.json(resultado);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) throw new Error('No se recibió archivo.');
        
        const fileBuffer = await readFile(tmpPath);
        let sourceText = '';

        // Leemos el PDF localmente y rapidísimo
        if (req.file.mimetype === 'application/pdf') {
            const data = await pdfParse(fileBuffer);
            sourceText = data.text;
        } else {
            sourceText = fileBuffer.toString('utf-8');
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
        const prompt = `Contexto de la clase:\n${context}\n\nResponde como un tutor amable a esta duda: ${question}`;
        const result = await model.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor Ultrarrápido activo en puerto ${PORT}`));
