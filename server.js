import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { readFile, unlink } from 'fs/promises';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'tutoria-secret-2026';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

if (!process.env.GROQ_API_KEY)   console.error("⚠️  FALTA GROQ_API_KEY");
if (!process.env.MONGODB_URI)    console.warn("⚠️  FALTA MONGODB_URI");

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ══ MONGODB ══
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ MongoDB conectado'))
        .catch(e => console.error('❌ MongoDB error:', e.message));
}

// ── Catálogos hardcodeados
const SEMESTRES = ['1er Semestre','2do Semestre','3er Semestre','4to Semestre','5to Semestre','6to Semestre'];
const MATERIAS = [
    'Español','Matemáticas','Historia Universal','Historia de México',
    'Geografía','Biología','Química','Física','Inglés',
    'Filosofía','Ética y Valores','Informática','Educación Física',
    'Administración','Contabilidad','Economía','Arte y Cultura'
];

// ── Esquemas MongoDB

// Invitación (generada por admin para cada maestro)
const invitacionSchema = new mongoose.Schema({
    codigo:    { type: String, unique: true, index: true },
    nombre:    String,
    email:     String,
    grupos:    [{ semestre: String, materia: String }],
    usada:     { type: Boolean, default: false },
    maestroId: { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', default: null },
    creadoEn:  { type: Date, default: Date.now }
});

// Maestro
const maestroSchema = new mongoose.Schema({
    nombre:      { type: String, required: true },
    email:       { type: String, required: true, unique: true, index: true },
    passwordHash:{ type: String, required: true },
    creadoEn:    { type: Date, default: Date.now }
});
const Maestro = mongoose.models.Maestro || mongoose.model('Maestro', maestroSchema);

// Grupo
const grupoSchema = new mongoose.Schema({
    shortId:   { type: String, unique: true, index: true },
    nombre:    String,          // "Química - 3er Semestre"
    semestre:  String,
    materia:   String,
    maestroId: { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    creadoEn:  { type: Date, default: Date.now }
});
const Grupo = mongoose.models.Grupo || mongoose.model('Grupo', grupoSchema);

// Sesión — TTL de 180 días automático
const sesionSchema = new mongoose.Schema({
    shortId:    { type: String, unique: true, index: true },
    nombre:     String,
    grupoId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    grupoNombre:String,
    semestre:   String,
    materia:    String,
    titulo:     String,
    fecha:      String,
    hora:       String,
    escuchoPodcast:   { type: Boolean, default: false },
    tarjetasAbiertas: [Number],
    respuestasQuiz: [{
        pregunta: String, opciones: [String],
        seleccionada: Number, correcta: Number, esCorrecta: Boolean
    }],
    chatMensajes: [{ role: String, texto: String, hora: String }],
    correctas:  Number,
    total:      Number,
    pct:        Number,
    codigo:     String,
    tareaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Tarea', default: null, index: true },
    creadoEn:   { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 } // 180 días TTL
});
const Sesion = mongoose.models.Sesion || mongoose.model('Sesion', sesionSchema);

// Clase compartida — TTL 180 días
const claseSchema = new mongoose.Schema({
    shortId:  { type: String, unique: true, index: true },
    titulo:   String,
    data:     Object,
    vistas:   { type: Number, default: 0 },
    creadoEn: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 }
});
const Clase = mongoose.models.Clase || mongoose.model('Clase', claseSchema);

// Tarea asignada por maestro — TTL 180 días
const tareaSchema = new mongoose.Schema({
    shortId:   { type: String, unique: true, index: true },
    maestroId: { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    grupoId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    titulo:    String,
    abstract:  String,       // resumen breve generado por IA para la tarjeta
    resumen:   String,       // clase magistral completa
    flashcards: [Object],
    poolPreguntas: [Object], // 15-18 preguntas; alumnos ven 6 random
    contexto:  String,
    vistas:    { type: Number, default: 0 },
    creadoEn:  { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 }
});
const Tarea = mongoose.models.Tarea || mongoose.model('Tarea', tareaSchema);

const Invitacion = mongoose.models.Invitacion || mongoose.model('Invitacion', invitacionSchema);

// ── Helpers
function generarShortId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
}
async function shortIdUnico(Model) {
    let id, exists = true;
    while (exists) { id = generarShortId(); exists = await Model.findOne({ shortId: id }); }
    return id;
}
function verifyToken(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ','');
    if (!token) return res.status(401).json({ error: 'No autorizado.' });
    try { req.maestro = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Token inválido.' }); }
}

// ── Groq
async function groqCall(messages, jsonMode = false) {
    const body = { model: GROQ_MODEL, messages, temperature: 0.7, max_tokens: 4096 };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions', body,
        { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
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
        const ct = response.headers['content-type'] || '';
        if (ct.includes('application/pdf')) return (await pdfParse(response.data)).text;
        if (ct.includes('text/html')) {
            const $ = cheerio.load(response.data.toString('utf-8'));
            // Remover todo lo que no es contenido educativo
            $('script,style,nav,footer,aside,header,iframe,noscript,.ad,.ads,.advertisement,.sidebar,.menu,.navbar,.cookie,.popup,.modal,form,button').remove();
            // Priorizar el contenido principal
            const mainContent = $('article, main, .content, .post, .entry, #content, #main, .article-body').text();
            if (mainContent.trim().length > 200) return mainContent.replace(/\s+/g,' ').trim();
            // Fallback: headings y párrafos
            return $('h1,h2,h3,h4,p,li,td,th,blockquote').text().replace(/\s+/g,' ').trim();
        }
        return response.data.toString('utf-8');
    } catch { throw new Error("El sitio bloqueó la lectura. Copia y pega el texto directamente."); }
}

// ── Procesador IA
async function procesarConIA(sourceText) {
    if (!sourceText || sourceText.length < 50)
        throw new Error("No se encontró suficiente texto para analizar.");

    const messages = [
        { role: 'system', content: 'Eres un tutor experto. Respondes ÚNICAMENTE con JSON válido, sin texto extra, sin markdown.' },
        { role: 'user', content: `Eres un profesor de preparatoria experto. Basándote ÚNICAMENTE en el siguiente contenido, crea una clase magistral COMPLETA en español.

REGLAS ESTRICTAS:
- El resumen debe tener mínimo 5 párrafos largos y detallados sobre el tema
- Usa <br><br> entre párrafos y <b>negritas</b> para conceptos clave
- Escribe como clase magistral fluida, sin listas
- El quiz debe tener exactamente 6 preguntas de opción múltiple con 4 opciones REALES y específicas del tema
- NUNCA uses letras sueltas (A, B, C, D) como opciones — cada opción debe ser una respuesta completa
- Las flashcards deben cubrir los 6 conceptos más importantes del tema
- TODO debe basarse en el contenido proporcionado, no en conocimiento general

FORMATO JSON (responde SOLO con este JSON, sin texto adicional):
{
  "titulo": "Título descriptivo del tema estudiado",
  "resumen": "Clase magistral detallada con <b>conceptos clave</b> en negritas y <br><br> entre párrafos...",
  "quiz": [
    {"p": "¿Pregunta específica sobre el tema?", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 0},
    {"p": "¿Segunda pregunta específica?", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 2},
    {"p": "¿Tercera pregunta específica?", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 1},
    {"p": "¿Cuarta pregunta específica?", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 3},
    {"p": "¿Quinta pregunta específica?", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 0},
    {"p": "¿Sexta pregunta específica?", "o": ["Opción A completa", "Opción B completa", "Opción C completa", "Opción D completa"], "r": 1}
  ],
  "flashcards": [
    {"anverso": "Concepto clave 1", "definicion": "Definición clara y precisa en 1-2 oraciones", "contexto": "Ejemplo concreto de cómo se aplica o usa este concepto"},
    {"anverso": "Concepto clave 2", "definicion": "Definición clara y precisa en 1-2 oraciones", "contexto": "Ejemplo concreto de cómo se aplica o usa este concepto"},
    {"anverso": "Concepto clave 3", "definicion": "Definición clara y precisa en 1-2 oraciones", "contexto": "Ejemplo concreto de cómo se aplica o usa este concepto"},
    {"anverso": "Concepto clave 4", "definicion": "Definición clara y precisa en 1-2 oraciones", "contexto": "Ejemplo concreto de cómo se aplica o usa este concepto"},
    {"anverso": "Concepto clave 5", "definicion": "Definición clara y precisa en 1-2 oraciones", "contexto": "Ejemplo concreto de cómo se aplica o usa este concepto"},
    {"anverso": "Concepto clave 6", "definicion": "Definición clara y precisa en 1-2 oraciones", "contexto": "Ejemplo concreto de cómo se aplica o usa este concepto"}
  ]
}

CONTENIDO A ESTUDIAR:
${sourceText.substring(0, 28000)}` }
    ];

    const text = await groqCall(messages, true);
    const data = JSON.parse(text);
    data.contexto = sourceText.substring(0, 10000);
    return data;
}

// ── Procesador IA para Tarea — genera pool de 15 preguntas + abstract
async function procesarConIAPool(sourceText) {
    if (!sourceText || sourceText.length < 50)
        throw new Error("No se encontró suficiente texto para analizar.");

    const messages = [
        { role: 'system', content: 'Eres un tutor experto. Respondes ÚNICAMENTE con JSON válido, sin texto extra, sin markdown.' },
        { role: 'user', content: `Eres un profesor de preparatoria experto. Basándote ÚNICAMENTE en el contenido, crea una clase magistral COMPLETA en español.

REGLAS ESTRICTAS:
- El resumen debe tener mínimo 5 párrafos largos y detallados sobre el tema
- Usa <br><br> entre párrafos y <b>negritas</b> para conceptos clave
- Escribe como clase magistral fluida, sin listas
- El quiz debe tener EXACTAMENTE 15 preguntas de opción múltiple con 4 opciones REALES y específicas
- NUNCA uses letras sueltas (A, B, C, D) como opciones — cada opción debe ser una respuesta completa
- Las preguntas deben cubrir distintos aspectos/niveles del tema (memorización, comprensión, aplicación)
- Las flashcards deben cubrir los 6 conceptos más importantes
- El abstract debe ser 2-3 oraciones que expliquen de qué trata el tema y para qué sirve (para el alumno)
- TODO debe basarse en el contenido proporcionado, no en conocimiento general

FORMATO JSON (responde SOLO con este JSON):
{
  "titulo": "Título descriptivo del tema estudiado",
  "abstract": "2-3 oraciones: de qué trata el tema y por qué es importante para el alumno.",
  "resumen": "Clase magistral con <b>conceptos clave</b> y <br><br> entre párrafos...",
  "quiz": [
    {"p": "¿Pregunta 1?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0},
    {"p": "¿Pregunta 2?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 1},
    {"p": "¿Pregunta 3?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2},
    {"p": "¿Pregunta 4?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 3},
    {"p": "¿Pregunta 5?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0},
    {"p": "¿Pregunta 6?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 1},
    {"p": "¿Pregunta 7?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2},
    {"p": "¿Pregunta 8?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 3},
    {"p": "¿Pregunta 9?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0},
    {"p": "¿Pregunta 10?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 1},
    {"p": "¿Pregunta 11?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2},
    {"p": "¿Pregunta 12?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 3},
    {"p": "¿Pregunta 13?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0},
    {"p": "¿Pregunta 14?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 1},
    {"p": "¿Pregunta 15?", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2}
  ],
  "flashcards": [
    {"anverso": "Concepto 1", "definicion": "Definición", "contexto": "Ejemplo"},
    {"anverso": "Concepto 2", "definicion": "Definición", "contexto": "Ejemplo"},
    {"anverso": "Concepto 3", "definicion": "Definición", "contexto": "Ejemplo"},
    {"anverso": "Concepto 4", "definicion": "Definición", "contexto": "Ejemplo"},
    {"anverso": "Concepto 5", "definicion": "Definición", "contexto": "Ejemplo"},
    {"anverso": "Concepto 6", "definicion": "Definición", "contexto": "Ejemplo"}
  ]
}

CONTENIDO A ESTUDIAR:
${sourceText.substring(0, 28000)}` }
    ];

    const text = await groqCall(messages, true);
    const data = JSON.parse(text);
    return data;
}

// ══ RUTAS PÚBLICAS ══

// Catálogos para el frontend
app.get('/api/catalogos', (req, res) => {
    res.json({ semestres: SEMESTRES, materias: MATERIAS });
});

// Listar grupos (para el desplegable del alumno)
app.get('/api/grupos', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.json({ grupos: [] });
        const grupos = await Grupo.find().select('shortId nombre semestre materia').sort({ semestre: 1, materia: 1 });
        res.json({ grupos });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Estudiar
app.post('/api/estudiar', async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        let texto = input.trim();
        if (texto.startsWith('http')) texto = await extraerTextoWeb(texto);
        res.json(await procesarConIA(texto));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/estudiar-archivo', upload.array('archivos', 10), async (req, res) => {
    const archivos = req.files || [];
    const tmpPaths = archivos.map(f => f.path);
    try {
        if (!archivos.length) return res.status(400).json({ error: 'No se recibieron archivos.' });
        let textoTotal = '';

        for (const archivo of archivos) {
            const buf = await readFile(archivo.path);
            const mime = archivo.mimetype;
            let texto = '';
            if (mime === 'application/pdf') {
                try { texto = (await pdfParse(buf)).text; }
                catch { texto = ''; }
            } else if (mime.startsWith('image/')) {
                const response = await axios.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    { model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                      messages: [{ role: 'user', content: [
                          { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
                          { type: 'text', text: `Eres un asistente educativo. Extrae ÚNICAMENTE el contenido educativo relevante de esta imagen.

IGNORA completamente: menús de navegación, botones, publicidad, encabezados de sitios web, pies de página, íconos, imágenes decorativas, redes sociales, precios, nombres de marcas no relevantes, elementos de UI/UX.

EXTRAE y transcribe: títulos y subtítulos del tema, definiciones, conceptos clave, explicaciones, fórmulas, datos históricos, fechas importantes, nombres de personas relevantes al tema, listas de características, procesos o pasos explicados, cualquier contenido que un estudiante necesite aprender.

Si es una foto de apuntes o libro: transcribe el texto completo con precisión.
Si es una captura de pantalla de un sitio educativo: extrae solo el artículo o lección, ignora el resto.
Si hay diagramas o tablas: descríbelos con el contenido que muestran.

Responde directamente con el contenido extraído, sin comentarios sobre lo que ignoraste.` }
                      ]}], max_tokens: 4096 },
                    { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
                );
                texto = response.data.choices[0].message.content;
            } else {
                texto = buf.toString('utf-8');
            }
            if (texto.trim()) textoTotal += texto + '\n\n';
        }

        if (!textoTotal.trim() || textoTotal.trim().length < 30)
            throw new Error('No se encontró suficiente texto en los archivos.');

        res.json(await procesarConIA(textoTotal));
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { for (const p of tmpPaths) await unlink(p).catch(() => {}); }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const answer = await groqCall([
            { role: 'system', content: 'Eres un tutor amable de preparatoria. Responde en español de forma concisa y educativa. NUNCA generes contenido inapropiado, violento, sexual, político o que no sea estrictamente educativo. Si el alumno pregunta algo fuera del tema de estudio, redirigelo amablemente al tema.' },
            { role: 'user', content: `Contexto del tema estudiado:\n${context}\n\nPregunta del alumno: ${question}` }
        ]);
        res.json({ answer });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ CHAT DEL MAESTRO — con contexto de datos del grupo ══
app.post('/api/maestro/chat', verifyToken, async (req, res) => {
    try {
        const { grupoId, pregunta, historial } = req.body;
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });

        // Construir contexto del grupo si se proporciona
        let contextoGrupo = '';
        if (grupoId && mongoose.connection.readyState) {
            const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id }).select('nombre semestre materia');
            if (grupo) {
                const sesiones = await Sesion.find({ grupoId })
                    .sort({ creadoEn: -1 })
                    .select('nombre pct correctas total creadoEn respuestasQuiz escuchoPodcast')
                    .limit(200);

                const hace7dias = new Date(Date.now() - 7*24*60*60*1000);
                const alumnosMap = {};
                [...sesiones].reverse().forEach(s => {
                    if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = { nombre: s.nombre, sesiones:[], pctTotal:0 };
                    alumnosMap[s.nombre].sesiones.push({ pct: s.pct, fecha: s.creadoEn });
                    alumnosMap[s.nombre].pctTotal += (s.pct||0);
                });
                const alumnos = Object.values(alumnosMap).map(a => {
                    const prom = Math.round(a.pctTotal / a.sesiones.length);
                    const sems = a.sesiones.filter(s => new Date(s.fecha) >= hace7dias).length;
                    const ult = a.sesiones[a.sesiones.length-1];
                    const ant = a.sesiones[a.sesiones.length-2];
                    const tend = ult && ant ? ult.pct - ant.pct : 0;
                    const diasInact = ult ? Math.floor((Date.now()-new Date(ult.fecha))/86400000) : 999;
                    return `- ${a.nombre}: promedio ${prom}%, ${a.sesiones.length} sesiones totales, ${sems} esta semana, tendencia ${tend>=0?'+':''}${tend}pts, última actividad hace ${diasInact} días`;
                });

                const fallosMap = {};
                sesiones.forEach(s => (s.respuestasQuiz||[]).forEach(r => {
                    if (!r.esCorrecta) fallosMap[r.pregunta] = (fallosMap[r.pregunta]||0)+1;
                }));
                const topFallos = Object.entries(fallosMap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([p,v])=>`"${p}" (${v}x)`);

                const promGrupo = sesiones.length ? Math.round(sesiones.reduce((a,s)=>a+(s.pct||0),0)/sesiones.length) : 0;
                const semsTotal = sesiones.filter(s => new Date(s.creadoEn) >= hace7dias).length;

                contextoGrupo = `
GRUPO: ${grupo.nombre} | ${grupo.materia} | ${grupo.semestre}
ESTADÍSTICAS DEL GRUPO:
- Promedio general: ${promGrupo}%
- Total de entregas: ${sesiones.length} (${semsTotal} esta semana)
- Total alumnos únicos: ${alumnos.length}

ALUMNOS (ordenados por promedio desc):
${alumnos.sort((a,b) => {
    const pa = parseInt(a.match(/promedio (\d+)/)?.[1]||0);
    const pb = parseInt(b.match(/promedio (\d+)/)?.[1]||0);
    return pb - pa;
}).join('\n')}

TEMAS MÁS FALLADOS: ${topFallos.join(' | ') || 'Sin datos suficientes'}`;
            }
        }

        // Construir historial de mensajes para contexto multi-turno
        const mensajesHistorial = (historial||[]).slice(-8).map(m => ({
            role: m.role === 'maestro' ? 'user' : 'assistant',
            content: m.texto
        }));

        const messages = [
            { role: 'system', content: `Eres un asistente pedagógico experto para maestros de preparatoria. Tu rol es analizar datos de desempeño de alumnos y dar consejos ACCIONABLES, concretos y con nombres reales.

REGLAS:
- Respuestas máximo 3-4 párrafos cortos o listas breves
- Siempre usa los nombres reales de los alumnos cuando los tienes
- Da recomendaciones pedagógicas específicas (no genéricas)
- Si te piden recursos, sugiere estrategias de búsqueda concretas
- Habla directamente al maestro (tutéalo)
- Si no tienes datos de un grupo, dilo y ofrece consejos generales
${contextoGrupo ? `\nDATOS ACTUALES DEL GRUPO:\n${contextoGrupo}` : ''}` },
            ...mensajesHistorial,
            { role: 'user', content: pregunta }
        ];

        const answer = await groqCall(messages);
        res.json({ answer });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ BÚSQUEDA DE RECURSOS EDUCATIVOS DE CALIDAD ══
app.post('/api/maestro/recursos', verifyToken, async (req, res) => {
    try {
        const { tema } = req.body;
        if (!tema || tema.length < 3) return res.status(400).json({ error: 'Escribe un tema para buscar.' });

        const prompt = `Eres un experto en recursos educativos digitales. Un maestro de preparatoria necesita materiales de ALTA CALIDAD sobre: "${tema}".

INSTRUCCIONES CLAVE:

1. CALIDAD SOBRE RESTRICCIÓN: El internet es vasto. Busca los mejores recursos disponibles — pueden ser .com, .org, .edu, .net, o cualquier dominio. Lo que importa es que sean contenido serio y confiable, no el dominio.

2. EVALUACIÓN DE ACCESIBILIDAD — Para cada recurso pregúntate: "¿Puede un alumno abrir este link y leer/ver el contenido completo SIN registrarse ni pagar?" 
   - Si sí → procesable: true
   - Si no (paywall, login requerido, suscripción) → procesable: false
   - Videos de YouTube, Vimeo, etc. → procesable: false (son material de apoyo visual)

3. URLS ESPECÍFICAS — NUNCA pongas la homepage de un sitio (ej: britannica.com). Siempre el artículo específico del tema (ej: britannica.com/event/French-Revolution). Si no conoces la URL exacta del artículo, construye una URL probable basada en cómo ese sitio organiza su contenido.

4. PAYWALL CONOCIDOS — Estos SIEMPRE son procesable: false: Coursera, Udemy, edX (cursos de pago), NYT, WSJ, The Economist, Nature (artículos cerrados), CNN, BBC (algunos), Medium (artículos de pago).

5. BALANCE — Busca 4-5 recursos procesables (texto/PDF) y 2-3 videos de apoyo.

FORMATO JSON (responde SOLO con este JSON válido):
{
  "recursos": [
    {
      "titulo": "Título descriptivo y específico del recurso",
      "fuente": "Nombre del sitio o institución",
      "tipo": "Artículo" | "PDF" | "Libro" | "Video" | "Infografía",
      "nivel": "Preparatoria" | "Universidad" | "General",
      "descripcion": "2 oraciones: qué cubre exactamente y por qué es útil para este tema",
      "url": "https://url-especifica-del-articulo-no-homepage.com/tema-especifico",
      "idioma": "Español" | "Inglés",
      "procesable": true,
      "razon_acceso": "Libre acceso sin registro" | "Paywall/Login requerido" | "Video (solo referencia)"
    }
  ],
  "consejo": "Consejo pedagógico de 1-2 oraciones sobre cómo usar estos recursos con el grupo."
}

Tema a buscar: "${tema}"`;

        const text = await groqCall([
            { role: 'system', content: 'Eres un experto en recursos educativos digitales. Respondes ÚNICAMENTE con JSON válido, sin texto extra, sin markdown.' },
            { role: 'user', content: prompt }
        ], true);

        const data = JSON.parse(text);

        // Separar en procesables y material extra
        const recursos = data.recursos || [];
        data.paraTarea   = recursos.filter(r => r.procesable === true && r.tipo !== 'Video');
        data.materialExtra = recursos.filter(r => r.procesable === false || r.tipo === 'Video');

        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clase compartida
app.post('/api/clase', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { titulo, data } = req.body;
        if (!titulo || !data) return res.status(400).json({ error: 'Faltan datos.' });
        const shortId = await shortIdUnico(Clase);
        await Clase.create({ shortId, titulo, data });
        res.json({ shortId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clase/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const clase = await Clase.findOneAndUpdate({ shortId: req.params.shortId }, { $inc: { vistas: 1 } }, { new: true });
        if (!clase) return res.status(404).json({ error: 'Clase no encontrada.' });
        res.json(clase.data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guardar sesión del alumno
app.post('/api/sesion', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre, grupoId, semestre, materia, titulo, fecha, hora,
                escuchoPodcast, tarjetasAbiertas, respuestasQuiz, chatMensajes,
                correctas, total, pct, codigo, tareaId } = req.body;
        if (!nombre || !titulo) return res.status(400).json({ error: 'Faltan datos.' });

        let grupoNombre = '';
        if (grupoId) {
            const g = await Grupo.findById(grupoId);
            if (g) grupoNombre = g.nombre;
        }

        const shortId = await shortIdUnico(Sesion);
        await Sesion.create({
            shortId, nombre, grupoId, grupoNombre, semestre, materia,
            titulo, fecha, hora,
            escuchoPodcast: escuchoPodcast || false,
            tarjetasAbiertas: tarjetasAbiertas || [],
            respuestasQuiz: respuestasQuiz || [],
            chatMensajes: chatMensajes || [],
            correctas, total, pct, codigo,
            tareaId: tareaId || null
        });
        res.json({ shortId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sesion/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const s = await Sesion.findOne({ shortId: req.params.shortId });
        if (!s) return res.status(404).json({ error: 'Sesión no encontrada.' });
        res.json(s);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ RUTAS DE MAESTRO ══

// Registro de maestro (requiere código de invitación generado por admin)
app.post('/api/maestro/registro', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { password, codigoInvitacion } = req.body;
        if (!password || !codigoInvitacion) return res.status(400).json({ error: 'Faltan datos.' });

        // Buscar invitación válida
        const inv = await Invitacion.findOne({ codigo: codigoInvitacion, usada: false });
        if (!inv) return res.status(403).json({ error: 'Código de invitación inválido o ya usado.' });

        // Verificar que el email no tenga ya cuenta
        const existe = await Maestro.findOne({ email: inv.email });
        if (existe) return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });

        // Crear maestro
        const passwordHash = await bcrypt.hash(password, 10);
        const maestro = await Maestro.create({ nombre: inv.nombre, email: inv.email, passwordHash });

        // Crear grupos automáticamente según la invitación
        for (const g of (inv.grupos || [])) {
            if (!SEMESTRES.includes(g.semestre) || !MATERIAS.includes(g.materia)) continue;
            const shortId = await shortIdUnico(Grupo);
            await Grupo.create({
                shortId,
                nombre: `${g.materia} — ${g.semestre}`,
                semestre: g.semestre,
                materia: g.materia,
                maestroId: maestro._id
            });
        }

        // Marcar invitación como usada
        inv.usada = true;
        inv.maestroId = maestro._id;
        await inv.save();

        const token = jwt.sign({ id: maestro._id, nombre: maestro.nombre, email: maestro.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, nombre: maestro.nombre, email: maestro.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login de maestro
app.post('/api/maestro/login', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email, password } = req.body;
        const maestro = await Maestro.findOne({ email: email.toLowerCase() });
        if (!maestro) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        const ok = await bcrypt.compare(password, maestro.passwordHash);
        if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        const token = jwt.sign({ id: maestro._id, nombre: maestro.nombre, email: maestro.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, nombre: maestro.nombre, email: maestro.email });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear grupo (requiere token)
app.post('/api/maestro/grupo', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { semestre, materia } = req.body;
        if (!semestre || !materia) return res.status(400).json({ error: 'Faltan semestre y materia.' });
        if (!SEMESTRES.includes(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        if (!MATERIAS.includes(materia)) return res.status(400).json({ error: 'Materia inválida.' });
        const nombre = `${materia} — ${semestre}`;
        // Verificar que el maestro no tenga ya ese grupo
        const existe = await Grupo.findOne({ maestroId: req.maestro.id, semestre, materia });
        if (existe) return res.status(409).json({ error: 'Ya tienes ese grupo creado.' });
        const shortId = await shortIdUnico(Grupo);
        const grupo = await Grupo.create({ shortId, nombre, semestre, materia, maestroId: req.maestro.id });
        res.json(grupo);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ver grupos del maestro
app.get('/api/maestro/grupos', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupos = await Grupo.find({ maestroId: req.maestro.id }).sort({ semestre: 1, materia: 1 });
        res.json({ grupos });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ RUTAS DE TAREA ══

// Crear tarea (maestro sube contenido, IA genera clase + pool una sola vez)
app.post('/api/maestro/tarea', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { input, grupoId } = req.body;
        if (!input) return res.status(400).json({ error: 'Falta contenido.' });

        // Resolver texto si es URL
        let texto = input.trim();
        if (texto.startsWith('http')) texto = await extraerTextoWeb(texto);

        // Generar clase + pool de 15 preguntas (una sola llamada a IA)
        const generated = await procesarConIAPool(texto);

        const shortId = await shortIdUnico(Tarea);
        const tarea = await Tarea.create({
            shortId,
            maestroId: req.maestro.id,
            grupoId:   grupoId || null,
            titulo:    generated.titulo,
            abstract:  generated.abstract || '',
            resumen:   generated.resumen,
            flashcards: generated.flashcards || [],
            poolPreguntas: generated.quiz || [],
            contexto:  texto.substring(0, 10000)
        });

        res.json({ shortId: tarea.shortId, titulo: tarea.titulo, abstract: tarea.abstract });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar tareas del maestro (con conteo de sesiones por tarea)
app.get('/api/maestro/tareas', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const tareas = await Tarea.find({ maestroId: req.maestro.id })
            .select('shortId titulo abstract grupoId vistas creadoEn')
            .sort({ creadoEn: -1 });

        // Contar sesiones vinculadas a cada tarea
        const counts = await Promise.all(
            tareas.map(t => Sesion.countDocuments({ tareaId: t._id }))
        );

        const resultado = tareas.map((t, i) => ({
            ...t.toObject(),
            entregas: counts[i]
        }));

        res.json({ tareas: resultado });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar tarea del maestro
app.delete('/api/maestro/tarea/:shortId', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const tarea = await Tarea.findOneAndDelete({ shortId: req.params.shortId, maestroId: req.maestro.id });
        if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ruta pública — alumno carga la tarea (recibe 6 preguntas random del pool)
app.get('/api/tarea/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const tarea = await Tarea.findOneAndUpdate(
            { shortId: req.params.shortId },
            { $inc: { vistas: 1 } },
            { new: true }
        );
        if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });

        // Seleccionar 6 preguntas aleatorias del pool
        const pool = tarea.poolPreguntas || [];
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        const quiz6 = shuffled.slice(0, Math.min(6, shuffled.length));

        res.json({
            shortId:    tarea.shortId,
            titulo:     tarea.titulo,
            abstract:   tarea.abstract,
            resumen:    tarea.resumen,
            flashcards: tarea.flashcards,
            quiz:       quiz6,
            contexto:   tarea.contexto,
            grupoId:    tarea.grupoId,
            esTarea:    true   // flag para que el frontend sepa el origen
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agregar grupos con código de invitación adicional
app.post('/api/maestro/agregar-grupo', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { codigoInvitacion } = req.body;
        if (!codigoInvitacion) return res.status(400).json({ error: 'Falta el código.' });
        const inv = await Invitacion.findOne({ codigo: codigoInvitacion, usada: false });
        if (!inv) return res.status(403).json({ error: 'Código inválido o ya usado.' });
        const gruposCreados = [];
        for (const g of (inv.grupos || [])) {
            if (!SEMESTRES.includes(g.semestre) || !MATERIAS.includes(g.materia)) continue;
            const existe = await Grupo.findOne({ maestroId: req.maestro.id, semestre: g.semestre, materia: g.materia });
            if (existe) continue;
            const shortId = await shortIdUnico(Grupo);
            const grupo = await Grupo.create({ shortId, nombre: `${g.materia} — ${g.semestre}`, semestre: g.semestre, materia: g.materia, maestroId: req.maestro.id });
            gruposCreados.push(grupo);
        }
        inv.usada = true; inv.maestroId = req.maestro.id; await inv.save();
        res.json({ grupos: gruposCreados });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dashboard de un grupo — Fase 2: datos enriquecidos
app.get('/api/maestro/grupo/:grupoId', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupo = await Grupo.findOne({ _id: req.params.grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const sesiones = await Sesion.find({ grupoId: req.params.grupoId })
            .sort({ creadoEn: -1 }).select('-__v -chatMensajes');

        const total = sesiones.length;
        const promedio = total ? Math.round(sesiones.reduce((a,s) => a+(s.pct||0), 0) / total) : 0;

        // ── Preguntas más falladas (solo las que fallan >50% del tiempo)
        const fallosTotales = {};
        const fallosConteo = {};
        sesiones.forEach(s => {
            (s.respuestasQuiz||[]).forEach(r => {
                fallosConteo[r.pregunta] = (fallosConteo[r.pregunta]||0) + 1;
                if (!r.esCorrecta) fallosTotales[r.pregunta] = (fallosTotales[r.pregunta]||0) + 1;
            });
        });
        const preguntasMasFalladas = Object.entries(fallosTotales)
            .map(([pregunta, veces]) => ({
                pregunta, veces,
                total: fallosConteo[pregunta] || veces,
                pctFallo: Math.round((veces / (fallosConteo[pregunta]||veces)) * 100)
            }))
            .filter(f => f.pctFallo >= 50)
            .sort((a,b) => b.pctFallo - a.pctFallo)
            .slice(0, 5);

        // ── Por alumno: sesiones cronológicas para tendencia
        const alumnosMap = {};
        [...sesiones].reverse().forEach(s => {
            if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = {
                nombre: s.nombre,
                sesiones: 0, pctTotal: 0,
                historial: [],   // [{pct, fecha}] ordenado ASC
                ultimaSesion: null
            };
            const a = alumnosMap[s.nombre];
            a.sesiones++;
            a.pctTotal += (s.pct||0);
            a.historial.push({ pct: s.pct||0, fecha: s.creadoEn });
            a.ultimaSesion = s.creadoEn; // último en DESC = más reciente
        });
        // Corregir ultimaSesion (viene reversed, tomamos el de sesiones DESC)
        sesiones.forEach(s => {
            if (alumnosMap[s.nombre] && !alumnosMap[s.nombre]._ultimaSet) {
                alumnosMap[s.nombre].ultimaSesion = s.creadoEn;
                alumnosMap[s.nombre]._ultimaSet = true;
            }
        });

        const hace7dias = new Date(Date.now() - 7*24*60*60*1000);
        const hace14dias = new Date(Date.now() - 14*24*60*60*1000);
        const hoy = new Date();

        const alumnos = Object.values(alumnosMap).map(a => {
            const pctPromedio = Math.round(a.pctTotal / a.sesiones);
            // Tendencia: diferencia entre última y penúltima sesión
            const h = a.historial;
            let tendencia = 0;
            if (h.length >= 2) tendencia = h[h.length-1].pct - h[h.length-2].pct;
            // Bajó más del 20% en las últimas 2 sesiones
            const enRiesgo = h.length >= 2 && (h[h.length-1].pct - h[h.length-2].pct) <= -20;
            // Sin actividad +7 días
            const diasInactivo = a.ultimaSesion
                ? Math.floor((hoy - new Date(a.ultimaSesion)) / 86400000) : 999;
            const inactivo = diasInactivo >= 7;
            // Sesiones esta semana vs semana anterior
            const sesionesSemana = a.historial.filter(h => new Date(h.fecha) >= hace7dias).length;
            const sesionesSemanaAnt = a.historial.filter(h => new Date(h.fecha) >= hace14dias && new Date(h.fecha) < hace7dias).length;
            // Promedio semana actual
            const pctsSemana = a.historial.filter(h => new Date(h.fecha) >= hace7dias).map(h => h.pct);
            const promedioSemana = pctsSemana.length ? Math.round(pctsSemana.reduce((a,b)=>a+b,0)/pctsSemana.length) : null;
            return {
                nombre: a.nombre,
                sesiones: a.sesiones,
                pctPromedio,
                promedioSemana,
                tendencia,
                enRiesgo,
                inactivo,
                diasInactivo,
                sesionesSemana,
                sesionesSemanaAnt,
                ultimaSesion: a.ultimaSesion,
                historial: h.slice(-6) // últimas 6 sesiones para mini sparkline
            };
        }).sort((a,b) => b.pctPromedio - a.pctPromedio);

        // ── Top 3 semana (más sesiones + mejor promedio esta semana)
        const top3Semana = [...alumnos]
            .filter(a => a.sesionesSemana > 0)
            .sort((a,b) => {
                if (b.sesionesSemana !== a.sesionesSemana) return b.sesionesSemana - a.sesionesSemana;
                return (b.promedioSemana||0) - (a.promedioSemana||0);
            })
            .slice(0,3)
            .map((a,i) => ({ ...a, posicion: i+1 }));

        // ── Alumnos en riesgo
        const enRiesgo = alumnos.filter(a => a.enRiesgo || a.inactivo);

        // ── Gráfica semanal: promedio del grupo por semana (últimas 8 semanas)
        const graficaSemanal = [];
        for (let i = 7; i >= 0; i--) {
            const inicio = new Date(Date.now() - (i+1)*7*24*60*60*1000);
            const fin    = new Date(Date.now() - i*7*24*60*60*1000);
            const sesionesSem = sesiones.filter(s => new Date(s.creadoEn) >= inicio && new Date(s.creadoEn) < fin);
            const prom = sesionesSem.length
                ? Math.round(sesionesSem.reduce((a,s)=>a+(s.pct||0),0)/sesionesSem.length) : null;
            const label = fin.toLocaleDateString('es-MX',{day:'numeric',month:'short'});
            graficaSemanal.push({ label, promedio: prom, sesiones: sesionesSem.length });
        }

        // ── Heatmap por día de la semana
        const diasNombre = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
        const heatmap = Array(7).fill(0);
        sesiones.forEach(s => { heatmap[new Date(s.creadoEn).getDay()]++; });
        const heatmapData = diasNombre.map((d,i) => ({ dia: d, sesiones: heatmap[i] }));

        res.json({
            grupo, total, promedio,
            preguntasMasFalladas,
            alumnos, sesiones,
            top3Semana,
            enRiesgo,
            graficaSemanal,
            heatmapData
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Comparativa entre todos los grupos del maestro
app.get('/api/maestro/grupos/comparativa', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupos = await Grupo.find({ maestroId: req.maestro.id });
        const hace7dias = new Date(Date.now() - 7*24*60*60*1000);

        const comparativa = await Promise.all(grupos.map(async g => {
            const sesiones = await Sesion.find({ grupoId: g._id })
                .select('pct nombre creadoEn').sort({ creadoEn: -1 });
            const total = sesiones.length;
            const promedio = total ? Math.round(sesiones.reduce((a,s)=>a+(s.pct||0),0)/total) : 0;
            const sesionesSemana = sesiones.filter(s => new Date(s.creadoEn) >= hace7dias).length;
            const alumnos = new Set(sesiones.map(s=>s.nombre)).size;
            const promedioSemana = (() => {
                const ss = sesiones.filter(s => new Date(s.creadoEn) >= hace7dias);
                return ss.length ? Math.round(ss.reduce((a,s)=>a+(s.pct||0),0)/ss.length) : null;
            })();
            return { grupoId: g._id, nombre: g.nombre, semestre: g.semestre, materia: g.materia,
                     total, promedio, promedioSemana, sesionesSemana, alumnos };
        }));

        res.json({ comparativa });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══ LEADERBOARD PÚBLICO (sin auth — el maestro comparte el link) ══
app.get('/api/leaderboard/:grupoId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupo = await Grupo.findById(req.params.grupoId).select('nombre semestre materia');
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        // Sesiones de los últimos 7 días para ranking semanal
        const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const sesiones = await Sesion.find({ grupoId: req.params.grupoId })
            .sort({ creadoEn: -1 })
            .select('nombre pct correctas total creadoEn escuchoPodcast');

        const sesionsSemana = sesiones.filter(s => new Date(s.creadoEn) >= hace7dias);

        // Calcular ranking por alumno
        const alumnosMap = {};
        sesiones.forEach(s => {
            if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = {
                nombre: s.nombre,
                sesiones: 0, sesionsSemana: 0,
                pctTotal: 0, pctSemana: 0,
                perfectos: 0, perfectosSemana: 0,
                ultimaSesion: null
            };
            const a = alumnosMap[s.nombre];
            a.sesiones++;
            a.pctTotal += (s.pct || 0);
            if (s.pct === 100) a.perfectos++;
            if (!a.ultimaSesion) a.ultimaSesion = s.creadoEn;
        });
        sesionsSemana.forEach(s => {
            if (alumnosMap[s.nombre]) {
                alumnosMap[s.nombre].sesionsSemana++;
                alumnosMap[s.nombre].pctSemana += (s.pct || 0);
                if (s.pct === 100) alumnosMap[s.nombre].perfectosSemana++;
            }
        });

        // Aplicar fórmula de ranking
        // scoreRanking = (0.35 * constancia) + (0.30 * promedio) + (0.20 * mejora) + (0.15 * perfectos)
        const ranking = Object.values(alumnosMap).map(a => {
            const promedio = a.sesiones > 0 ? Math.round(a.pctTotal / a.sesiones) : 0;
            const constancia = Math.min(a.sesionsSemana / 7 * 100, 100); // max 100
            const promedioSemana = a.sesionsSemana > 0 ? Math.round(a.pctSemana / a.sesionsSemana) : 0;
            const perfectosPts = Math.min(a.perfectosSemana * 25, 100);
            const score = Math.round(
                (0.35 * constancia) +
                (0.30 * promedioSemana) +
                (0.20 * promedio) +
                (0.15 * perfectosPts)
            );
            return { nombre: a.nombre, promedio, promedioSemana, sesiones: a.sesiones,
                     sesionsSemana: a.sesionsSemana, perfectos: a.perfectos,
                     perfectosSemana: a.perfectosSemana, score, ultimaSesion: a.ultimaSesion };
        }).sort((a, b) => b.score - a.score);

        res.json({ grupo, ranking, totalAlumnos: ranking.length, semana: hace7dias });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ PANEL ADMIN ══

function verifyAdmin(req, res, next) {
    const pwd   = (req.headers['x-admin-password'] || '').trim();
    const email = (req.headers['x-admin-email'] || '').trim();
    const adminPwd   = (process.env.ADMIN_PASSWORD || '').trim();
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
    if (!adminPwd || !adminEmail) return res.status(503).json({ error: 'Panel admin no configurado.' });
    if (pwd !== adminPwd || email !== adminEmail) return res.status(401).json({ error: 'Credenciales incorrectas.' });
    next();
}

// Stats generales
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const [totalMaestros, totalSesiones, totalGrupos] = await Promise.all([
            Maestro.countDocuments(),
            Sesion.countDocuments(),
            Grupo.countDocuments()
        ]);
        const sesionesHoy = await Sesion.countDocuments({
            creadoEn: { $gte: new Date(new Date().setHours(0,0,0,0)) }
        });
        res.json({ totalMaestros, totalSesiones, totalGrupos, sesionesHoy });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Todas las sesiones (vista admin global)
app.get('/api/admin/sesiones', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const sesiones = await Sesion.find()
            .sort({ creadoEn: -1 })
            .limit(500)
            .select('-__v -respuestasQuiz -chatMensajes -tarjetasAbiertas');
        const grupos = await Grupo.find().select('_id nombre semestre materia');
        res.json({ sesiones, grupos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Generar código de invitación único
function generarCodigoInvitacion(nombre) {
    const iniciales = nombre.split(' ').map(w=>w[0]||'').join('').toUpperCase().substring(0,4);
    const rand = Math.random().toString(36).substring(2,6).toUpperCase();
    return `INV-${iniciales}-${rand}`;
}

// Listar todos los maestros
app.get('/api/admin/maestros', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const maestros = await Maestro.find().select('-passwordHash').sort({ creadoEn: -1 });
        const invitaciones = await Invitacion.find({ usada: false });
        res.json({ maestros, invitaciones });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear invitación para un maestro (genera código + crea grupos automáticamente al usarse)
app.post('/api/admin/invitacion', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre, email, grupos } = req.body;
        // grupos = [{ semestre: '1er Semestre', materia: 'Química' }, ...]
        if (!nombre || !email || !grupos?.length)
            return res.status(400).json({ error: 'Faltan nombre, email o grupos.' });

        // Verificar que el email no tenga ya cuenta
        const existe = await Maestro.findOne({ email: email.toLowerCase() });
        if (existe) return res.status(409).json({ error: 'Ya existe una cuenta con ese email.' });

        // Generar código único
        let codigo = generarCodigoInvitacion(nombre);
        while (await Invitacion.findOne({ codigo })) {
            codigo = generarCodigoInvitacion(nombre);
        }

        const inv = await Invitacion.create({ codigo, nombre, email: email.toLowerCase(), grupos });
        res.json({ codigo: inv.codigo, nombre: inv.nombre, email: inv.email, grupos: inv.grupos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar invitación no usada
app.delete('/api/admin/invitacion/:codigo', verifyAdmin, async (req, res) => {
    try {
        await Invitacion.deleteOne({ codigo: req.params.codigo, usada: false });
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar maestro completo (cascada: grupos + sesiones)
app.delete('/api/admin/maestro/:maestroId', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { maestroId } = req.params;
        // Encontrar grupos del maestro
        const grupos = await Grupo.find({ maestroId });
        const grupoIds = grupos.map(g => g._id);
        // Borrar sesiones de esos grupos
        const sesionesBorradas = grupoIds.length
            ? (await Sesion.deleteMany({ grupoId: { $in: grupoIds } })).deletedCount : 0;
        // Borrar grupos
        const gruposBorrados = (await Grupo.deleteMany({ maestroId })).deletedCount;
        // Borrar maestro
        await Maestro.deleteOne({ _id: maestroId });
        res.json({ gruposBorrados, sesionesBorradas });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar sesiones de un alumno específico
app.delete('/api/admin/sesiones/alumno', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre } = req.body;
        if (!nombre) return res.status(400).json({ error: 'Falta el nombre.' });
        const result = await Sesion.deleteMany({ nombre });
        res.json({ borradas: result.deletedCount });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar sesiones de un grupo
app.delete('/api/admin/sesiones/grupo', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { grupoId } = req.body;
        if (!grupoId) return res.status(400).json({ error: 'Falta el grupoId.' });
        const result = await Sesion.deleteMany({ grupoId });
        res.json({ borradas: result.deletedCount });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Depuración completa — borrar todas las sesiones
app.delete('/api/admin/sesiones/todo', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const result = await Sesion.deleteMany({});
        res.json({ borradas: result.deletedCount });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Tutor IA en puerto ${PORT} — modelo: ${GROQ_MODEL}`));
