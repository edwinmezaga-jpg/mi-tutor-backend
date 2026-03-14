import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFile, unlink } from 'fs/promises';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

// ── Cliente texto: gemini-2.5-flash (cuenta 1)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const modelTexto = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
});

// ── Cliente imagen: gemini-2.5-flash-image Nano Banana (cuenta 2)
const genAIImagen = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY_IMAGEN || process.env.GEMINI_API_KEY || ''
);
const modelImagen = genAIImagen.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
});

// ── Multer — archivos temporales en /tmp, máx 20MB
const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se permiten imágenes (JPG, PNG, WEBP) o PDF.'));
    }
});

// ── Convierte archivo a base64
async function archivoABase64(path, mimetype) {
    const buffer = await readFile(path);
    return { data: buffer.toString('base64'), mimeType: mimetype };
}

// ── Genera imagen educativa con Nano Banana
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

// ── Función central: texto → título + resumen + quiz + imagen
async function procesarConIA(sourceText) {
    const prompt = `Actúa como un tutor experto para estudiantes de secundaria y preparatoria.
Analiza el siguiente contenido y responde ÚNICAMENTE con un JSON válido, sin texto extra antes ni después, sin bloques de código markdown:
{
  "titulo": "Título claro del tema",
  "resumen": "Resumen explicativo en 3 párrafos usando lenguaje sencillo, separados por saltos de línea",
  "quiz": [
    {"p": "Pregunta 1", "o": ["Opción A", "Opción B", "Opción C"], "r": 0},
    {"p": "Pregunta 2", "o": ["Opción A", "Opción B", "Opción C"], "r": 1},
    {"p": "Pregunta 3", "o": ["Opción A", "Opción B", "Opción C"], "r": 2}
  ]
}
El campo "r" es el índice (0, 1 o 2) de la respuesta correcta dentro del arreglo "o".
Contenido: ${sourceText}`;

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
    } else {
        console.log('⚠️  Sin imagen, continuando sin ella');
    }

    return data;
}

// ── POST /api/estudiar — texto plano
app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta el campo 'input'." });
        const resultado = await procesarConIA(input);
        res.json(resultado);
    } catch (error) {
        console.error('Error en /api/estudiar:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── POST /api/estudiar-archivo — foto o PDF
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
            throw new Error('No se pudo extraer texto del archivo. Asegúrate de que sea legible.');
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
        if (!context || !question) {
            return res.status(400).json({ error: "Faltan los campos 'context' y/o 'question'." });
        }

        const prompt = `Eres un tutor amigable para estudiantes de secundaria y preparatoria. Basándote ÚNICAMENTE en el siguiente contexto, responde la pregunta del alumno de forma clara y sencilla. Si la pregunta no tiene relación con el tema, pídele amablemente que se enfoque en el contenido.

Contexto:
${context}

Pregunta del alumno:
${question}`;

        const result = await modelTexto.generateContent(prompt);
        res.json({ answer: result.response.text() });
    } catch (error) {
        console.error('Error en /api/chat:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ── GET /
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: '🚀 Tutor Backend activo y funcionando.' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en línea en el puerto ${PORT}`);
    console.log(`   Texto:  ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}`);
    console.log(`   Imagen: gemini-2.5-flash-image (Nano Banana)`);
});
