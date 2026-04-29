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
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const APP_VERSION = 'Beta 2.0.0.4';
const PACKAGE_VERSION = '2.0.0-beta.4';

if (!process.env.JWT_SECRET) {
    console.error("❌ FALTA JWT_SECRET en variables de entorno. El servidor no puede iniciar sin un secreto.");
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Rate-limit simple en memoria (no requiere deps adicionales)
const rateLimitBuckets = new Map();
function rateLimit(maxReq, windowMs) {
    return (req, res, next) => {
        const ip = (req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown')
            .toString().split(',')[0].trim();
        const key = `${ip}:${req.path}`;
        const now = Date.now();
        const bucket = rateLimitBuckets.get(key);
        if (!bucket || now > bucket.reset) {
            rateLimitBuckets.set(key, { count: 1, reset: now + windowMs });
            return next();
        }
        if (bucket.count >= maxReq) {
            const retry = Math.ceil((bucket.reset - now) / 1000);
            return res.status(429).json({ error: `Demasiadas solicitudes. Intenta en ${retry}s.`, retryAfter: retry });
        }
        bucket.count++;
        next();
    };
}
// Limpieza periódica de buckets expirados
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitBuckets) if (now > v.reset) rateLimitBuckets.delete(k);
}, 60000).unref();

// ── Sanitizado de mensajes de usuario antes de inyectar en prompts
function sanitizeChatInput(str, maxLen = 4000) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/[<>{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, maxLen);
}

// ── Comparación timing-safe de strings (mitiga side-channel en admin auth)
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function parseOptionalDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function lateInfo(fechaVencimiento, now = new Date()) {
    const venc = parseOptionalDate(fechaVencimiento);
    if (!venc || now <= venc) {
        return { fechaVencimiento: venc, entregaTarde: false, retrasoMinutos: 0 };
    }
    return {
        fechaVencimiento: venc,
        entregaTarde: true,
        retrasoMinutos: Math.max(1, Math.ceil((now - venc) / 60000))
    };
}

function formatRetraso(mins = 0) {
    const total = Math.max(0, Number(mins) || 0);
    const dias = Math.floor(total / 1440);
    const horas = Math.floor((total % 1440) / 60);
    const minutos = total % 60;
    const partes = [];
    if (dias) partes.push(`${dias} d`);
    if (horas) partes.push(`${horas} h`);
    if (minutos || !partes.length) partes.push(`${minutos} min`);
    return partes.join(' ');
}

function buildLocalDateTime(fecha, hora) {
    if (!fecha) return null;
    return parseOptionalDate(`${fecha}T${hora || '23:59'}:00-07:00`);
}

function chatGuardrail(rol, pregunta, hasContext = true) {
    const q = (pregunta || '').toLowerCase();
    const forbidden = [
        'novia','novio','ligar','apuesta','casino','crypto','bitcoin','dinero rapido',
        'hack','hackear','arma','drogas','sexo','porno','politica partidista','chisme',
        'instagram','tiktok','facebook','whatsapp personal','meme','videojuego'
    ];
    if (forbidden.some(w => q.includes(w))) {
        const scope = {
            alumno: 'tu clase, tarea activa y dudas educativas relacionadas',
            maestro: 'tus grupos, tareas, alumnos, resultados y estrategias pedagogicas',
            director: 'tu institucion, maestros, grupos, alumnos y metricas escolares',
            admin: 'operacion del sistema, usuarios, costos, despliegue y soporte'
        }[rol] || 'este modulo';
        return { ok: false, answer: `No puedo ayudarte con eso desde este chat. Aqui solo puedo apoyar con ${scope}.` };
    }
    if (rol === 'alumno' && !hasContext) {
        return { ok: false, answer: 'No puedo responder sin una clase o tarea activa. Abre una tarea o genera una clase y con gusto te ayudo sobre ese material.' };
    }
    return { ok: true };
}

function explicacionFallback(q = {}) {
    const opciones = q.o || q.opciones || [];
    const correcta = Number.isInteger(q.r) ? q.r : q.correcta;
    const respuesta = opciones[correcta] || 'la opción correcta';
    return `La respuesta correcta es "${respuesta}" porque es la opción que coincide directamente con el concepto evaluado. Revisa la definición central y compara por qué las otras opciones cambian, exageran o confunden una parte del tema.`;
}

function normalizeQuestion(q = {}) {
    const opciones = Array.isArray(q.o) ? q.o : Array.isArray(q.opciones) ? q.opciones : [];
    const correcta = Number.isInteger(q.r) ? q.r : Number.isInteger(q.correcta) ? q.correcta : 0;
    const base = { ...q, o: opciones, r: correcta };
    base.explicacion = String(q.explicacion || q.porQueCorrecta || q.retroalimentacion || '').trim() || explicacionFallback(base);
    return base;
}

function normalizeQuestions(arr = []) {
    return (Array.isArray(arr) ? arr : []).map(normalizeQuestion);
}

// ── Modelos de IA disponibles
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GROQ_KEY    = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

if (!GEMINI_KEY && !GROQ_KEY) console.error("⚠️  FALTA GEMINI_API_KEY o GROQ_API_KEY");
if (!process.env.MONGODB_URI) console.warn("⚠️  FALTA MONGODB_URI");
console.log(`🤖 Motor IA: ${GEMINI_KEY ? `Gemini (${GEMINI_MODEL})` : `GROQ (${GROQ_MODEL})`}`);


// ══ MONGODB ══
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('✅ MongoDB conectado'))
        .catch(e => console.error('❌ MongoDB error:', e.message));
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'Tutor IA Backend',
        version: APP_VERSION,
        packageVersion: PACKAGE_VERSION,
        node: process.version,
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        env: {
            jwtSecret: !!process.env.JWT_SECRET,
            mongodbUri: !!process.env.MONGODB_URI,
            geminiKey: !!GEMINI_KEY,
            groqKey: !!GROQ_KEY,
            adminEmail: !!process.env.ADMIN_EMAIL,
            adminPassword: !!process.env.ADMIN_PASSWORD
        },
        ai: {
            provider: GEMINI_KEY ? 'gemini' : GROQ_KEY ? 'groq' : 'none',
            primary: GEMINI_KEY ? 'gemini' : GROQ_KEY ? 'groq' : 'none',
            fallback: GROQ_KEY ? 'groq' : null,
            geminiConfigured: !!GEMINI_KEY,
            groqConfigured: !!GROQ_KEY,
            geminiModel: GEMINI_KEY ? GEMINI_MODEL : null,
            groqModel: GROQ_KEY ? GROQ_MODEL : null,
            tokenUsageLogging: 'UsageLog MongoDB'
        }
    });
});

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
const INVITACION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const invitacionSchema = new mongoose.Schema({
    codigo:           { type: String, unique: true, index: true },
    nombre:           String,
    email:            String,
    grupos:           [{ semestre: String, materia: String }],
    usada:            { type: Boolean, default: false },
    maestroId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', default: null },
    creadoEn:         { type: Date, default: Date.now },
    fechaVencimiento: { type: Date, default: () => new Date(Date.now() + INVITACION_TTL_MS) }
});

// Maestro
const maestroSchema = new mongoose.Schema({
    nombre:       { type: String, required: true },
    email:        { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    escuelaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Escuela', index: true, default: null },
    resetToken:    { type: String, default: null },
    resetTokenExp: { type: Date,   default: null },
    creadoEn:     { type: Date, default: Date.now }
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
    fechaVencimiento: { type: Date, default: null },
    entregaTarde: { type: Boolean, default: false },
    retrasoMinutos: { type: Number, default: 0 },
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
    podcast:   String,       // guión conversacional para TTS
    glosario:  [Object],     // [{termino, definicion}]
    ejemplosPracticos: [Object], // [{problema, solucion_paso_a_paso}]
    rubrica:   [Object],     // [{criterio, niveles:[...]}]
    flashcards: [Object],
    poolPreguntas: [Object], // 15-18 preguntas; alumnos ven 6 random
    contexto:  String,
    fechaVencimiento: { type: Date, default: null },
    origen: { type: String, enum: ['link','texto','archivo'], default: 'texto' },
    archivoResumen: String,
    vistas:    { type: Number, default: 0 },
    creadoEn:  { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 }
});
const Tarea = mongoose.models.Tarea || mongoose.model('Tarea', tareaSchema);

const Invitacion = mongoose.models.Invitacion || mongoose.model('Invitacion', invitacionSchema);

// PushSubscription — para notificaciones PWA
const pushSubSchema = new mongoose.Schema({
    maestroId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    subscription: { type: Object, required: true }, // {endpoint, keys: {p256dh, auth}}
    creadoEn:     { type: Date, default: Date.now }
});
const PushSub = mongoose.models.PushSub || mongoose.model('PushSub', pushSubSchema);

// Examen Final — combina múltiples tareas
const examenSchema = new mongoose.Schema({
    shortId:     { type: String, unique: true, index: true },
    maestroId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    grupoId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    titulo:      String,
    instrucciones: String,
    preguntas:   [Object], // combinadas de múltiples tareas
    tiempoLimite: { type: Number, default: 60 }, // minutos
    fechaVencimiento: { type: Date, default: null },
    origen: { type: String, enum: ['tareas','archivo'], default: 'tareas' },
    fuenteTexto: String,
    activo:      { type: Boolean, default: true },
    creadoEn:    { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 }
});
const Examen = mongoose.models.Examen || mongoose.model('Examen', examenSchema);

const examenEntregaSchema = new mongoose.Schema({
    shortId:   { type: String, unique: true, index: true },
    examenId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Examen', index: true },
    alumnoId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Alumno', default: null, index: true },
    nombre:    String,
    grupoId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    respuestas: [Object],
    correctas: Number,
    total:     Number,
    pct:       Number,
    fechaVencimiento: { type: Date, default: null },
    entregaTarde: { type: Boolean, default: false },
    retrasoMinutos: { type: Number, default: 0 },
    creadoEn:  { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 }
});
const ExamenEntrega = mongoose.models.ExamenEntrega || mongoose.model('ExamenEntrega', examenEntregaSchema);

// Sala de Quiz en Vivo
const salaQuizSchema = new mongoose.Schema({
    codigo:     { type: String, unique: true, index: true }, // 4 letras fácil de dictar
    maestroId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    grupoId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    titulo:     String,
    preguntas:  [Object],
    preguntaActual: { type: Number, default: -1 }, // -1 = sala abierta, esperando
    estado:     { type: String, enum: ['esperando','activa','terminada'], default: 'esperando' },
    respuestas: [{ // respuestas de alumnos en tiempo real
        alumno: String, preguntaIdx: Number,
        opcion: Number, esCorrecta: Boolean, tiempo: Number
    }],
    creadoEn:   { type: Date, default: Date.now, expires: 60 * 60 * 24 * 1 } // 1 día TTL
});
const SalaQuiz = mongoose.models.SalaQuiz || mongoose.model('SalaQuiz', salaQuizSchema);

// Alumno
const alumnoSchema = new mongoose.Schema({
    nombre:            { type: String, required: true },
    email:             { type: String, required: true, unique: true, index: true },
    passwordHash:      { type: String, required: true },
    grupoId:           { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    activo:            { type: Boolean, default: true },
    sesionesHoy:       { type: Number, default: 0 },
    ultimaFechaSesion: { type: String, default: '' },
    limiteDiario:      { type: Number, default: 10 },
    resetToken:        { type: String, default: null },
    resetTokenExp:     { type: Date, default: null },
    logros:            { type: [String], default: [] }, // IDs de logros desbloqueados
    creadoEn:          { type: Date, default: Date.now }
});
const Alumno = mongoose.models.Alumno || mongoose.model('Alumno', alumnoSchema);

// Escuela
const escuelaSchema = new mongoose.Schema({
    nombre:   { type: String, required: true },
    ciudad:   { type: String, default: 'Tijuana' },
    creadoEn: { type: Date, default: Date.now }
});
const Escuela = mongoose.models.Escuela || mongoose.model('Escuela', escuelaSchema);

// Director
const directorSchema = new mongoose.Schema({
    nombre:        { type: String, required: true },
    email:         { type: String, required: true, unique: true, index: true },
    passwordHash:  { type: String, required: true },
    escuelaId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Escuela', index: true },
    resetToken:    { type: String, default: null },
    resetTokenExp: { type: Date,   default: null },
    creadoEn:      { type: Date, default: Date.now }
});
const Director = mongoose.models.Director || mongoose.model('Director', directorSchema);

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

// Verifica token de alumno (obligatorio para estudiar)
function verifyAlumno(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Debes iniciar sesión para estudiar.', requireLogin: true });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.rol !== 'alumno') return res.status(403).json({ error: 'Acceso solo para alumnos.' });
        req.alumno = decoded;
        next();
    } catch { res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.', requireLogin: true }); }
}

// Middleware: verificar y aplicar límite diario
async function checkLimiteDiario(req, res, next) {
    try {
        const alumnoId = req.alumno?.id;
        if (!alumnoId) return next();
        const hoy = new Date().toISOString().split('T')[0];
        const alumno = await Alumno.findById(alumnoId);
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });
        if (alumno.ultimaFechaSesion !== hoy) {
            alumno.sesionesHoy = 0;
            alumno.ultimaFechaSesion = hoy;
        }
        const limite = alumno.limiteDiario || 10;
        if (alumno.sesionesHoy >= limite) {
            return res.status(429).json({
                error: `Alcanzaste tu límite de ${limite} sesiones por hoy. ¡Vuelve mañana!`,
                limiteSuperado: true, sesionesHoy: alumno.sesionesHoy, limite
            });
        }
        alumno.sesionesHoy += 1;
        await alumno.save();
        req.alumnoDoc = alumno;
        next();
    } catch(e) { next(); }
}

// Verifica token de alumno (o maestro) — permisivo para rutas legacy
function verifyAlumnoOLibre(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ','');
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.usuario = decoded;
            if (decoded.rol === 'alumno') req.alumno = decoded;
        } catch { /* token inválido — continuar sin usuario */ }
    }
    next();
}

// Verifica JWT del director
function verifyDirector(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No autorizado.' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.rol !== 'director') return res.status(403).json({ error: 'Acceso solo para directores.' });
        req.director = decoded;
        next();
    } catch { res.status(401).json({ error: 'Token inválido.' }); }
}

// ══ ADMIN — ESCUELAS Y DIRECTORES ══

app.post('/api/admin/escuela', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre, ciudad } = req.body;
        if (!nombre) return res.status(400).json({ error: 'Falta nombre de escuela.' });
        const escuela = await Escuela.create({ nombre, ciudad: ciudad || 'Tijuana' });
        res.json({ escuela });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/escuelas', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const escuelas = await Escuela.find().sort({ nombre: 1 }).lean();
        const enriquecidas = await Promise.all(escuelas.map(async e => {
            const [totalMaestros, directores] = await Promise.all([
                Maestro.countDocuments({ escuelaId: e._id }),
                Director.find({ escuelaId: e._id }).select('_id nombre email').lean()
            ]);
            return { ...e, totalMaestros, directores };
        }));
        res.json({ escuelas: enriquecidas });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/director', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre, email, password, escuelaId } = req.body;
        if (!nombre || !email || !password || !escuelaId) return res.status(400).json({ error: 'Faltan campos (nombre, email, contraseña y escuela son obligatorios).' });
        if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
        const existe = await Director.findOne({ email: email.toLowerCase() });
        if (existe) return res.status(409).json({ error: 'Ya existe un director con ese email.' });
        const passwordHash = await bcrypt.hash(password, 10);
        const director = await Director.create({ nombre, email: email.toLowerCase(), passwordHash, escuelaId });
        res.json({ director: { _id: director._id, nombre: director.nombre, email: director.email, escuelaId } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


app.patch('/api/admin/maestro/:maestroId/escuela', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { escuelaId } = req.body;
        const maestro = await Maestro.findByIdAndUpdate(req.params.maestroId, { escuelaId: escuelaId || null }, { new: true }).select('-passwordHash');
        if (!maestro) return res.status(404).json({ error: 'Maestro no encontrado.' });
        res.json({ maestro });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ DIRECTOR — LOGIN Y PORTAL ══

app.post('/api/director/login', rateLimit(20, 60_000), async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos.' });
        const director = await Director.findOne({ email: email.toLowerCase() });
        if (!director) return res.status(401).json({ error: 'Credenciales incorrectas.' });
        const ok = await bcrypt.compare(password, director.passwordHash);
        if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas.' });
        const escuela = await Escuela.findById(director.escuelaId).lean();
        const token = jwt.sign(
            { id: director._id, nombre: director.nombre, email: director.email, rol: 'director', escuelaId: director.escuelaId },
            JWT_SECRET, { expiresIn: '30d' }
        );
        res.json({ token, director: { nombre: director.nombre, email: director.email, escuela } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ DASHBOARD DIRECTOR — datos completos en una sola llamada ══
app.get('/api/director/dashboard', verifyDirector, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const escuelaId = req.director.escuelaId;

        const hace30 = new Date(Date.now()-30*24*60*60*1000);
        const hace7  = new Date(Date.now()-7*24*60*60*1000);
        const hace1  = new Date(Date.now()-24*60*60*1000);
        const hoy    = new Date(new Date().setHours(0,0,0,0));

        // Maestros y grupos de esta institución
        const maestros   = await Maestro.find({ escuelaId }).select('-passwordHash').lean();
        const maestroIds = maestros.map(m => m._id);
        const grupos     = await Grupo.find({ maestroId: { $in: maestroIds } }).lean();
        const grupoIds   = grupos.map(g => g._id);
        const alumnos    = await Alumno.find({ grupoId: { $in: grupoIds }, activo: true }).select('nombre email grupoId logros creadoEn limiteDiario').lean();
        const tareas     = await Tarea.find({ maestroId: { $in: maestroIds } }).select('titulo maestroId grupoId creadoEn').lean();

        // Sesiones de toda la institución
        const sesiones30 = await Sesion.find({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace30 } })
            .sort({ creadoEn: -1 }).select('nombre pct correctas total titulo fecha hora creadoEn grupoId escuchoPodcast').lean();

        const [sesToday, ses7d] = [
            sesiones30.filter(s => new Date(s.creadoEn) >= hoy).length,
            sesiones30.filter(s => new Date(s.creadoEn) >= hace7).length
        ];

        const promInst = sesiones30.length ? Math.round(sesiones30.reduce((a,s)=>a+(s.pct||0),0)/sesiones30.length) : null;

        // ── MÉTRICAS POR MAESTRO ──
        const metricasMaestros = await Promise.all(maestros.map(async m => {
            const mGrupos  = grupos.filter(g => String(g.maestroId) === String(m._id));
            const mGrupoIds = mGrupos.map(g => g._id);
            const mSes     = sesiones30.filter(s => mGrupoIds.some(id => String(id) === String(s.grupoId)));
            const mAlumnos = alumnos.filter(a => mGrupoIds.some(id => String(id) === String(a.grupoId)));
            const mTareas  = tareas.filter(t => String(t.maestroId) === String(m._id));
            const mSesToday = mSes.filter(s => new Date(s.creadoEn) >= hoy).length;
            const mSes7d    = mSes.filter(s => new Date(s.creadoEn) >= hace7).length;
            const mProm     = mSes.length ? Math.round(mSes.reduce((a,s)=>a+(s.pct||0),0)/mSes.length) : null;
            const ultimaAct = mSes[0]?.creadoEn || null;
            const diasInact = ultimaAct ? Math.floor((Date.now()-new Date(ultimaAct))/86400000) : 999;
            return {
                _id: m._id, nombre: m.nombre, email: m.email,
                totalGrupos: mGrupos.length, totalAlumnos: mAlumnos.length,
                totalTareas: mTareas.length, totalSesiones30: mSes.length,
                sesionesHoy: mSesToday, sesiones7d: mSes7d,
                promedio: mProm, diasInactividad: diasInact,
                ultimaActividad: ultimaAct,
                grupos: mGrupos.map(g=>({ _id: g._id, nombre: g.nombre, materia: g.materia, semestre: g.semestre }))
            };
        }));

        // Ordenar: destacados (más activos) y en alerta (más inactivos)
        const maestrosDestacados = [...metricasMaestros].sort((a,b) => b.sesiones7d - a.sesiones7d).slice(0,3);
        const maestrosAlerta     = metricasMaestros.filter(m => m.diasInactividad >= 7).sort((a,b) => b.diasInactividad - a.diasInactividad);

        // ── MÉTRICAS POR ALUMNO ──
        const alumnosMap = {};
        sesiones30.forEach(s => {
            if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = { pcts: [], sesiones: [] };
            alumnosMap[s.nombre].pcts.push(s.pct||0);
            alumnosMap[s.nombre].sesiones.push(s);
        });
        const alumnosDetalle = alumnos.map(a => {
            const data = alumnosMap[a.nombre] || { pcts: [], sesiones: [] };
            const prom = data.pcts.length ? Math.round(data.pcts.reduce((x,y)=>x+y,0)/data.pcts.length) : null;
            const ultimas3 = data.pcts.slice(0,3);
            const prom3    = ultimas3.length ? Math.round(ultimas3.reduce((x,y)=>x+y,0)/ultimas3.length) : null;
            const ult      = data.sesiones[0];
            const diasInact = ult ? Math.floor((Date.now()-new Date(ult.creadoEn))/86400000) : 999;
            const grupo    = grupos.find(g => String(g._id) === String(a.grupoId));
            return {
                _id: a._id, nombre: a.nombre,
                grupo: grupo ? { nombre: grupo.nombre, materia: grupo.materia } : null,
                promedio: prom, promedio3: prom3,
                totalSesiones: data.pcts.length,
                diasInactividad: diasInact,
                logros: (a.logros||[]).length,
                enRiesgo: prom3 !== null && prom3 < 60
            };
        });

        const alumnosRiesgo     = alumnosDetalle.filter(a => a.enRiesgo).sort((a,b)=>a.promedio3-b.promedio3);
        const alumnosDestacados = alumnosDetalle.filter(a => a.promedio !== null).sort((a,b)=>b.promedio-a.promedio).slice(0,5);

        // ── ACTIVIDAD RECIENTE (últimas 24h) ──
        const actividadReciente = sesiones30.filter(s => new Date(s.creadoEn) >= hace1).slice(0,20).map(s => {
            const grupo = grupos.find(g => String(g._id) === String(s.grupoId));
            const maestro = grupo ? maestros.find(m => String(m._id) === String(grupo.maestroId)) : null;
            return { nombre: s.nombre, titulo: s.titulo, pct: s.pct, hora: s.hora, fecha: s.fecha,
                     grupo: grupo?.nombre, maestro: maestro?.nombre };
        });

        // ── TOP TEMAS ──
        const temasMap = {};
        sesiones30.forEach(s => { temasMap[s.titulo] = (temasMap[s.titulo]||0)+1; });
        const topTemas = Object.entries(temasMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([tema,cnt])=>({ tema, sesiones: cnt }));

        // ── SESIONES POR DÍA (14 días) ──
        const diasMap = {};
        sesiones30.forEach(s => {
            const d = new Date(s.creadoEn).toISOString().split('T')[0];
            diasMap[d] = (diasMap[d]||0)+1;
        });
        const sesionesPorDia = [];
        for (let i=13; i>=0; i--) {
            const d = new Date(Date.now()-i*86400000).toISOString().split('T')[0];
            sesionesPorDia.push({ fecha: d, count: diasMap[d]||0 });
        }

        // ── TASA DE COMPLETACIÓN POR TAREA (todas, hasta 50) ──
        const tareasFull = await Tarea.find({ maestroId: { $in: maestroIds } })
            .select('titulo maestroId grupoId creadoEn fechaVencimiento shortId')
            .sort({ creadoEn: -1 }).limit(50).lean();
        const tareasConTasa = await Promise.all(tareasFull.map(async t => {
            const grupoAlumnos = alumnos.filter(a => String(a.grupoId) === String(t.grupoId)).length;
            const completaron  = await Sesion.countDocuments({ tareaId: t._id });
            const grupo = grupos.find(g => String(g._id) === String(t.grupoId));
            const maestro = maestros.find(m => String(m._id) === String(t.maestroId));
            return {
                _id: t._id, shortId: t.shortId, titulo: t.titulo,
                grupo: grupo ? grupo.nombre : '—',
                maestro: maestro ? maestro.nombre : '—',
                fechaVencimiento: t.fechaVencimiento,
                creadoEn: t.creadoEn,
                alumnos: grupoAlumnos, completaron,
                tasa: grupoAlumnos ? Math.round((completaron/grupoAlumnos)*100) : 0
            };
        }));

        // ── MAESTROS SIN ESCUELA (que el admin no ha asignado) — útil para que el director sepa que falta data
        const maestrosSinEscuela = await Maestro.countDocuments({ $or: [{ escuelaId: null }, { escuelaId: { $exists: false } }] });

        const escuela = await Escuela.findById(escuelaId).lean();

        res.json({
            escuela,
            kpis: {
                totalMaestros: maestros.length, totalGrupos: grupos.length,
                totalAlumnos: alumnos.length, totalTareas: tareas.length,
                sesionesHoy: sesToday, sesiones7d: ses7d, sesiones30d: sesiones30.length,
                promedioInstitucional: promInst, alumnosEnRiesgo: alumnosRiesgo.length,
                maestrosActivos7d: metricasMaestros.filter(m=>m.sesiones7d>0).length,
                maestrosSinEscuela
            },
            maestrosDestacados, maestrosAlerta, maestrosTodos: metricasMaestros,
            alumnosRiesgo: alumnosRiesgo.slice(0,10), alumnosDestacados,
            actividadReciente, topTemas, sesionesPorDia, tareasConTasa,
            // Banderas para el frontend
            avisos: {
                sinMaestros:        maestros.length === 0,
                sinAlumnos:         alumnos.length === 0,
                sinTareas:          tareas.length === 0,
                maestrosSinEscuela: maestrosSinEscuela > 0
            }
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/director/resumen', verifyDirector, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { escuelaId } = req.director;
        const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const maestros   = await Maestro.find({ escuelaId }).select('-passwordHash').lean();
        const maestroIds = maestros.map(m => m._id);
        const grupos     = await Grupo.find({ maestroId: { $in: maestroIds } }).lean();
        const grupoIds   = grupos.map(g => g._id);

        const [totalSesiones, sesionesRecientes, sesionesHoy, totalAlumnos] = await Promise.all([
            Sesion.countDocuments({ grupoId: { $in: grupoIds } }),
            Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace7dias } }),
            Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
            Alumno.countDocuments({ grupoId: { $in: grupoIds }, activo: true })
        ]);

        const todasSesiones = await Sesion.find({ grupoId: { $in: grupoIds } }).select('pct').lean();
        const promedioGeneral = todasSesiones.length
            ? Math.round(todasSesiones.reduce((a, s) => a + (s.pct || 0), 0) / todasSesiones.length) : null;

        // Maestros activos en últimos 7 días
        let maestrosActivos = 0;
        for (const m of maestros) {
            const mGrupoIds = grupos.filter(g => g.maestroId.toString() === m._id.toString()).map(g => g._id);
            const reciente = await Sesion.findOne({ grupoId: { $in: mGrupoIds }, creadoEn: { $gte: hace7dias } }).lean();
            if (reciente) maestrosActivos++;
        }

        const escuela = await Escuela.findById(escuelaId).lean();
        res.json({
            escuela, totalMaestros: maestros.length, maestrosActivos,
            totalGrupos: grupos.length, totalAlumnos, totalSesiones,
            sesionesRecientes, sesionesHoy, promedioGeneral
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/director/maestros', verifyDirector, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { escuelaId } = req.director;
        const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const maestros  = await Maestro.find({ escuelaId }).select('-passwordHash').lean();

        const detalle = await Promise.all(maestros.map(async m => {
            const grupos   = await Grupo.find({ maestroId: m._id }).lean();
            const grupoIds = grupos.map(g => g._id);
            const [totalTareas, totalSesiones, sesionesRecientes, totalAlumnos] = await Promise.all([
                Tarea.countDocuments({ maestroId: m._id }),
                Sesion.countDocuments({ grupoId: { $in: grupoIds } }),
                Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace7dias } }),
                Alumno.countDocuments({ grupoId: { $in: grupoIds }, activo: true })
            ]);
            const sesionesPct = await Sesion.find({ grupoId: { $in: grupoIds } }).select('pct').lean();
            const promedio = sesionesPct.length
                ? Math.round(sesionesPct.reduce((a, s) => a + (s.pct || 0), 0) / sesionesPct.length) : null;
            const [ultSesion, ultTarea] = await Promise.all([
                Sesion.findOne({ grupoId: { $in: grupoIds } }).sort({ creadoEn: -1 }).select('creadoEn').lean(),
                Tarea.findOne({ maestroId: m._id }).sort({ creadoEn: -1 }).select('creadoEn').lean()
            ]);
            const ultimaActividad = [ultSesion?.creadoEn, ultTarea?.creadoEn]
                .filter(Boolean).sort((a, b) => b - a)[0] || null;
            return { ...m, grupos, totalTareas, totalSesiones, sesionesRecientes, totalAlumnos, promedio, ultimaActividad };
        }));

        res.json({ maestros: detalle });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/director/grupo/:grupoId', verifyDirector, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { escuelaId } = req.director;
        const grupo = await Grupo.findById(req.params.grupoId).lean();
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });
        const maestro = await Maestro.findOne({ _id: grupo.maestroId, escuelaId }).lean();
        if (!maestro) return res.status(403).json({ error: 'Sin acceso a este grupo.' });

        const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const sesiones  = await Sesion.find({ grupoId: grupo._id })
            .sort({ creadoEn: -1 })
            .select('-chatMensajes -respuestasQuiz -tarjetasAbiertas').lean();
        const alumnos = await Alumno.find({ grupoId: grupo._id, activo: true }).select('-passwordHash').lean();

        // Agrupar sesiones por alumno
        const porAlumno = {};
        sesiones.forEach(s => {
            if (!porAlumno[s.nombre]) porAlumno[s.nombre] = [];
            porAlumno[s.nombre].push(s);
        });
        const resumenAlumnos = Object.entries(porAlumno).map(([nombre, ss]) => ({
            nombre,
            totalSesiones: ss.length,
            promedio: Math.round(ss.reduce((a, s) => a + (s.pct || 0), 0) / ss.length),
            recientes: ss.filter(s => new Date(s.creadoEn) >= hace7dias).length,
            ultimaActividad: ss[0]?.creadoEn
        })).sort((a, b) => b.promedio - a.promedio);

        const promedioGrupo = sesiones.length
            ? Math.round(sesiones.reduce((a, s) => a + (s.pct || 0), 0) / sesiones.length) : null;

        res.json({
            grupo, maestro, alumnos, resumenAlumnos, promedioGrupo,
            totalSesiones: sesiones.length,
            sesionesRecientes: sesiones.filter(s => new Date(s.creadoEn) >= hace7dias).length
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/director/alumno/:grupoId/:nombre', verifyDirector, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { escuelaId } = req.director;
        const grupo = await Grupo.findById(req.params.grupoId).lean();
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });
        const maestro = await Maestro.findOne({ _id: grupo.maestroId, escuelaId }).lean();
        if (!maestro) return res.status(403).json({ error: 'Sin acceso.' });
        const nombre = decodeURIComponent(req.params.nombre);
        const sesiones = await Sesion.find({ grupoId: grupo._id, nombre: { $regex: new RegExp(nombre, 'i') } })
            .sort({ creadoEn: -1 }).select('-chatMensajes -respuestasQuiz -tarjetasAbiertas').lean();
        const promedio = sesiones.length
            ? Math.round(sesiones.reduce((a, s) => a + (s.pct || 0), 0) / sesiones.length) : null;
        res.json({ nombre, grupo, sesiones, promedio, totalSesiones: sesiones.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RUTAS ALUMNO ──────────────────────────────────────────

// Registro de alumno (solo admin puede crear alumnos)
app.post('/api/admin/alumno', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre, email, password, grupoId } = req.body;
        if (!nombre || !email || !password) return res.status(400).json({ error: 'Faltan nombre, email o contraseña.' });
        const existe = await Alumno.findOne({ email: email.toLowerCase() });
        if (existe) return res.status(409).json({ error: 'Ya existe un alumno con ese email.' });
        const passwordHash = await bcrypt.hash(password, 10);
        const alumno = await Alumno.create({
            nombre, email: email.toLowerCase(), passwordHash,
            grupoId: grupoId || null, activo: true
        });
        res.json({ alumno: { _id: alumno._id, nombre: alumno.nombre, email: alumno.email, grupoId: alumno.grupoId } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk: crear varios alumnos a la vez
app.post('/api/admin/alumnos/bulk', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { alumnos, grupoId } = req.body; // alumnos: [{nombre, email, password}]
        if (!alumnos?.length) return res.status(400).json({ error: 'Sin alumnos en la lista.' });
        const resultados = { creados: 0, errores: [] };
        for (const a of alumnos) {
            try {
                const existe = await Alumno.findOne({ email: a.email.toLowerCase() });
                if (existe) { resultados.errores.push(`${a.email}: ya existe`); continue; }
                const passwordHash = await bcrypt.hash(a.password || 'Tutor2025!', 10);
                await Alumno.create({ nombre: a.nombre, email: a.email.toLowerCase(), passwordHash, grupoId: grupoId || null, activo: true });
                resultados.creados++;
            } catch(e) { resultados.errores.push(`${a.email}: ${e.message}`); }
        }
        res.json(resultados);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar alumnos (con filtro por grupo)
app.get('/api/admin/alumnos', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { grupoId } = req.query;
        const filtro = grupoId ? { grupoId } : {};
        const alumnos = await Alumno.find(filtro).select('-passwordHash').sort({ nombre: 1 });

        // Enriquecer con stats de sesiones
        const enriquecidos = await Promise.all(alumnos.map(async a => {
            const grupo = a.grupoId ? await Grupo.findById(a.grupoId).select('nombre semestre materia').lean() : null;
            const sesiones = await Sesion.find({ nombre: { $regex: new RegExp(a.nombre, 'i') } })
                .select('pct creadoEn').sort({ creadoEn: -1 }).limit(50).lean();
            const promedio = sesiones.length
                ? Math.round(sesiones.reduce((s, x) => s + (x.pct || 0), 0) / sesiones.length) : null;
            const ultimaActividad = sesiones[0]?.creadoEn || null;
            return { ...a.toObject(), grupo, totalSesiones: sesiones.length, promedio, ultimaActividad };
        }));

        const grupos = await Grupo.find().select('_id nombre semestre materia').lean();
        res.json({ alumnos: enriquecidos, grupos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Activar/desactivar o cambiar grupo de alumno
app.patch('/api/admin/alumno/:alumnoId', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { activo, grupoId } = req.body;
        const update = {};
        if (activo !== undefined) update.activo = activo;
        if (grupoId !== undefined) update.grupoId = grupoId || null;
        const alumno = await Alumno.findByIdAndUpdate(req.params.alumnoId, update, { new: true }).select('-passwordHash');
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });
        res.json({ alumno });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar alumno
app.delete('/api/admin/alumno/:alumnoId', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        await Alumno.findByIdAndDelete(req.params.alumnoId);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Login de alumno
app.post('/api/alumno/login', rateLimit(20, 60_000), async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos.' });
        const alumno = await Alumno.findOne({ email: email.toLowerCase() });
        if (!alumno) return res.status(401).json({ error: 'Credenciales incorrectas.' });
        if (!alumno.activo) return res.status(403).json({ error: 'Cuenta desactivada. Contacta a tu maestro.' });
        const ok = await bcrypt.compare(password, alumno.passwordHash);
        if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas.' });
        const grupo = alumno.grupoId ? await Grupo.findById(alumno.grupoId).select('nombre semestre materia shortId').lean() : null;
        const token = jwt.sign({ id: alumno._id, nombre: alumno.nombre, email: alumno.email, rol: 'alumno', grupoId: alumno.grupoId }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, alumno: { nombre: alumno.nombre, email: alumno.email, grupoId: alumno.grupoId, grupo } });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Groq
// ══ LLAMADA IA UNIVERSAL — Gemini 2.5 Flash (primero) + GROQ fallback ══
// Límites de tokens por tipo de llamada — incrementados para lecciones más ricas
const TOKEN_LIMITS = {
    estudiar: 16384, // clase magistral completa (era 8192, se truncaba)
    tarea:    16384, // pool de 15 preguntas + resumen largo + rubrica
    chat:     4096,  // respuestas de chat (era 2048)
    recursos: 2048,  // búsqueda de recursos
    examen:   6144,  // generación de examen
    vision:   6144,  // extracción de imagen estructurada
};

// ── Caché en memoria (TTL) para contenido generado por IA
//    Clave: md5(tipo + JSON.stringify(messages)) → evita regenerar la misma URL/texto
const iaCache = new Map();
const IA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
function iaCacheKey(tipo, messages) {
    const h = crypto.createHash('md5').update(tipo + '::' + JSON.stringify(messages)).digest('hex');
    return h;
}
function iaCacheGet(key) {
    const hit = iaCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) { iaCache.delete(key); return null; }
    return hit.value;
}
function iaCacheSet(key, value) {
    iaCache.set(key, { value, exp: Date.now() + IA_CACHE_TTL_MS });
    if (iaCache.size > 500) { // cap en 500 entradas
        const oldest = iaCache.keys().next().value;
        iaCache.delete(oldest);
    }
}

async function iaCall(messages, jsonMode = false, meta = {}) {
    const useCache = meta.tipo !== 'chat' && meta.cache !== false;
    const key = useCache ? iaCacheKey(meta.tipo || 'default', messages) : null;
    if (useCache) {
        const cached = iaCacheGet(key);
        if (cached) { console.log(`⚡ Cache hit [${meta.tipo}]`); return cached; }
    }

    let result;
    if (GEMINI_KEY) {
        try {
            result = await geminiCall(messages, jsonMode, meta);
            if (useCache) iaCacheSet(key, result);
            return result;
        } catch(e) {
            console.warn('Gemini falló tras reintentos, usando GROQ fallback:', e.message);
        }
    }
    if (!GROQ_KEY) throw new Error('No hay motor de IA configurado. Agrega GEMINI_API_KEY o GROQ_API_KEY en Render.');
    result = await groqCall(messages, jsonMode, meta);
    if (useCache) iaCacheSet(key, result);
    return result;
}

// ── Delay helper para backoff exponencial
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geminiCall(messages, jsonMode = false, meta = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs  = messages.filter(m => m.role !== 'system');
    const maxOut    = TOKEN_LIMITS[meta.tipo] || 4096;

    // Convertir formato OpenAI → Gemini
    const contents = userMsgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(m.content)
            ? m.content.map(c => c.type === 'image_url'
                ? { inlineData: { mimeType: c.image_url.url.split(';')[0].split(':')[1], data: c.image_url.url.split(',')[1] } }
                : { text: c.text || '' })
            : [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    })).filter(m => m.parts.some(p => (p.text || p.inlineData)));

    const body = {
        contents,
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
        generationConfig: {
            temperature: meta.temperature ?? (meta.tipo === 'chat' ? 0.8 : meta.tipo === 'vision' ? 0.05 : 0.7),
            maxOutputTokens: maxOut,
            ...(jsonMode ? { responseMimeType: 'application/json' } : {})
        },
        safetySettings: [
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' }
        ]
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

    // ── Reintentos exponenciales solo si el error es 429/5xx transitorio
    const maxAttempts = 3;
    const backoffs = [200, 400, 800];
    let response, lastErr;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            response = await axios.post(url, body, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 120000
            });
            break;
        } catch(e) {
            lastErr = e;
            const status = e.response?.status;
            const retriable = !status || status === 429 || (status >= 500 && status < 600) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
            if (!retriable || i === maxAttempts - 1) throw e;
            console.warn(`Gemini retry ${i+1}/${maxAttempts} tras ${status || e.code}`);
            await sleep(backoffs[i]);
        }
    }

    const candidate = response.data.candidates?.[0];
    if (!candidate) throw new Error('Gemini no retornó candidatos');
    if (candidate.finishReason === 'SAFETY') throw new Error('Contenido bloqueado por seguridad');

    const text = candidate.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text.trim()) throw new Error('Gemini retornó respuesta vacía');

    // Registrar uso de tokens
    const usage = response.data.usageMetadata || {};
    const tokensInput  = usage.promptTokenCount     || 0;
    const tokensOutput = usage.candidatesTokenCount || 0;
    const costoUSD = (tokensInput * 0.000000075) + (tokensOutput * 0.0000003);
    if (mongoose.connection.readyState && (tokensInput + tokensOutput) > 0) {
        UsageLog.create({
            escuelaId: meta.escuelaId || null, maestroId: meta.maestroId || null,
            tipo: meta.tipo || 'estudiar', modelo: GEMINI_MODEL,
            tokensInput, tokensOutput, tokensTotal: tokensInput + tokensOutput, costoUSD
        }).catch(() => {});
    }
    return text;
}

async function groqCall(messages, jsonMode = false, meta = {}) {
    const maxOut = Math.min(TOKEN_LIMITS[meta.tipo] || 4096, 4096); // GROQ max 4096
    const body   = { model: GROQ_MODEL, messages, temperature: 0.7, max_tokens: maxOut };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions', body,
        { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 45000 }
    );
    const usage = response.data.usage || {};
    const tokensInput  = usage.prompt_tokens    || 0;
    const tokensOutput = usage.completion_tokens || 0;
    const costoUSD = (tokensInput * 0.00000059) + (tokensOutput * 0.00000079);
    if (mongoose.connection.readyState && (tokensInput + tokensOutput) > 0) {
        UsageLog.create({
            escuelaId: meta.escuelaId || null, maestroId: meta.maestroId || null,
            tipo: meta.tipo || 'estudiar', modelo: GROQ_MODEL,
            tokensInput, tokensOutput, tokensTotal: tokensInput + tokensOutput, costoUSD
        }).catch(() => {});
    }
    return response.data.choices[0].message.content;
}

const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════════════════════════════════════
//  SISTEMA DE EXTRACCIÓN INTELIGENTE CON GEMINI GROUNDING
// ══════════════════════════════════════════════════════════════

function esYoutube(url) {
    return /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/.test(url);
}
function extraerYoutubeId(url) {
    const m = url.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

// ── Gemini con Google Search + url_context — lee CUALQUIER URL en tiempo real
async function extraerConGeminiGrounding(url) {
    if (!GEMINI_KEY) return null;
    const esVideo = esYoutube(url);
    const videoId = esVideo ? extraerYoutubeId(url) : null;

    const prompt = esVideo
        ? `Estás analizando este video de YouTube: ${url}\n\nTRANSCRIBE Y EXPANDE el contenido educativo completo del video con máximo detalle:\n• Todos los conceptos, definiciones y explicaciones que se dan.\n• Ejemplos concretos mencionados (datos, fechas, personajes, casos).\n• Conclusiones y puntos clave.\n• Si el video tiene capítulos o secciones, identifícalos.\n\nSi por alguna razón no puedes acceder al video directamente, busca información detallada sobre el tema del video usando el título y descripción como pista, e identifica qué tema enseña el video.\n\nDevuelve TODO el contenido textual sin resumir, listo para usarse como fuente de una clase educativa.`
        : `Accede y extrae el contenido educativo completo de esta URL: ${url}\n\nSi el sitio requiere suscripción o está bloqueado, busca el mismo contenido en fuentes libres (Wikipedia, Khan Academy, artículos académicos gratuitos) y proporciona información equivalente de alta calidad.\nExtrae: títulos, definiciones, explicaciones, ejemplos, datos importantes, fórmulas si aplica.\nDevuelve SOLO el contenido educativo, sin navegación ni publicidad. Mínimo 1500 caracteres.`;

    // Construir parts: si es video, agregamos fileData con la URL de YouTube (Gemini lo entiende nativamente)
    const parts = [{ text: prompt }];
    if (esVideo && videoId) {
        parts.push({
            file_data: {
                file_uri: `https://www.youtube.com/watch?v=${videoId}`,
                mime_type: "video/mp4"
            }
        });
    }

    // Tools: url_context (lee la URL exacta) + google_search (fallback de búsqueda).
    // Si es video usamos solo google_search porque ya pasamos el videoId nativamente.
    const tools = esVideo
        ? [{ google_search: {} }]
        : [{ url_context: {} }, { google_search: {} }];

    try {
        const body = {
            contents: [{ role: "user", parts }],
            tools,
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
            safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }]
        };
        const resp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
            body, { headers: { "Content-Type": "application/json" }, timeout: 90000 }
        );
        const candidate = resp.data.candidates?.[0];
        const texto = candidate?.content?.parts?.map(p => p.text || "").join("").trim();
        if (texto && texto.length > 200) {
            console.log(`✅ Gemini Grounding (${esVideo?'YT-native':'url_context'}): ${texto.length} chars`);
            const usage = resp.data.usageMetadata || {};
            if (mongoose.connection.readyState) {
                UsageLog.create({ tipo: "estudiar", modelo: GEMINI_MODEL + (esVideo?"-yt-native":"-url-context"),
                    tokensInput: usage.promptTokenCount || 0,
                    tokensOutput: usage.candidatesTokenCount || 0,
                    tokensTotal: (usage.promptTokenCount||0)+(usage.candidatesTokenCount||0),
                    costoUSD: ((usage.promptTokenCount||0)*0.000000075)+((usage.candidatesTokenCount||0)*0.0000003)
                }).catch(()=>{});
            }
            return { texto, videoId, esVideo };
        }
    } catch(e) {
        // Si falla con url_context (modelo no lo soporta), reintenta solo con google_search
        if (!esVideo && /url_context|tool|invalid/i.test(e.message || '')) {
            try {
                const body2 = {
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                    tools: [{ google_search: {} }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
                    safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }]
                };
                const r2 = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
                    body2, { headers: { "Content-Type": "application/json" }, timeout: 60000 }
                );
                const t2 = r2.data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
                if (t2 && t2.length > 200) {
                    console.log(`✅ Gemini Grounding (search-fallback): ${t2.length} chars`);
                    return { texto: t2, videoId, esVideo };
                }
            } catch(e2) { console.warn("Gemini Grounding fallback falló:", e2.message); }
        }
        console.warn("Gemini Grounding falló:", e.message);
    }
    return null;
}

// ── YouTube: transcript + múltiples fallbacks
async function extraerTextoYoutube(url) {
    const videoId = extraerYoutubeId(url);
    if (!videoId) throw new Error("No se pudo identificar el video de YouTube.");

    // 1. Gemini Grounding (más confiable)
    const geminiResult = await extraerConGeminiGrounding(url);
    if (geminiResult) return geminiResult;

    // 2. APIs de transcript
    const transcriptApis = [
        `https://yt-transcript-api.vercel.app/api/transcript?videoId=${videoId}&lang=es`,
        `https://yt-transcript-api.vercel.app/api/transcript?videoId=${videoId}&lang=en`,
        `https://api.kome.ai/api/tools/youtube-transcripts?video_id=${videoId}`,
    ];
    for (const apiUrl of transcriptApis) {
        try {
            const r = await axios.get(apiUrl, { timeout: 10000 }).catch(() => null);
            const transcript = r?.data?.transcript || r?.data?.transcripts || r?.data;
            if (Array.isArray(transcript) && transcript.length > 5) {
                const texto = transcript.map(t => t.text || t.content || "").filter(Boolean).join(" ");
                if (texto.length > 200) { console.log(`✅ Transcript API: ${texto.length} chars`); return { texto, videoId, esVideo: true }; }
            }
        } catch {}
    }

    // 3. Jina.ai para página de YouTube
    try {
        const j = await axios.get(`https://r.jina.ai/https://www.youtube.com/watch?v=${videoId}`, {
            timeout: 12000, headers: { "Accept": "text/plain" }
        });
        if (j.data?.length > 100) return { texto: j.data.substring(0, 6000), videoId, esVideo: true };
    } catch {}

    // 4. oEmbed fallback
    try {
        const oe = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { timeout: 8000 });
        const titulo = oe.data.title || "Video educativo";
        return { texto: `Video: "${titulo}" por ${oe.data.author_name || ""}. Genera una clase magistral completa sobre el tema: "${titulo}".`, videoId, esVideo: true };
    } catch {}

    return { texto: `Video YouTube ID: ${videoId}. Genera contenido educativo completo sobre el tema de este video.`, videoId, esVideo: true };
}

// ── Extracción web — cascada de 4 métodos
async function extraerTextoWeb(url) {
    if (!url.startsWith("http")) url = "https://" + url;
    if (esYoutube(url)) return await extraerTextoYoutube(url);

    // 1. Gemini Grounding (puede leer paywalls y sitios con JS pesado)
    const gr = await extraerConGeminiGrounding(url);
    if (gr) return gr.texto;

    // 2. Jina.ai Reader
    try {
        const j = await axios.get(`https://r.jina.ai/${url}`, {
            timeout: 20000,
            headers: { "Accept": "text/plain", "X-Return-Format": "markdown", "X-Timeout": "18",
                       "X-Remove-Selector": "header,footer,nav,.ad,.cookie,.popup,.modal,.sidebar,aside" }
        });
        if (j.data?.length > 400) {
            const texto = j.data
                .replace(/^(Title|URL Source|Published Time|Description|Markdown Content):.+$/gm, "")
                .replace(/!\[.*?\]\(.*?\)/g, "").replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
                .replace(/^#{1,6}\s+/gm, "").replace(/\n{3,}/g, "\n\n").trim();
            if (texto.length > 400) { console.log(`✅ Jina.ai: ${texto.length} chars`); return texto; }
        }
    } catch(e) { console.log("Jina.ai falló:", e.message); }

    // 3. Scraping directo con cheerio
    try {
        const response = await axios.get(url, {
            responseType: "arraybuffer", timeout: 20000, maxRedirects: 5,
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                       "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8" }
        });
        const ct = response.headers["content-type"] || "";
        const isPdfByExt = /\.pdf(\?|$)/i.test(url);
        if (ct.includes("application/pdf") || isPdfByExt) {
            // 3a. Intentar pdf-parse primero (rápido, gratis)
            try {
                const parsed = await pdfParse(response.data);
                const txt = (parsed.text || '').replace(/\s+\n/g,'\n').trim();
                if (txt.length > 100) { console.log(`✅ PDF extraído (${txt.length} chars)`); return txt; }
            } catch(e) { console.log("pdf-parse falló:", e.message); }
            // 3b. Si pdf-parse no rinde, mandar el PDF a Gemini Vision (inline base64)
            if (GEMINI_KEY && response.data.length < 18 * 1024 * 1024) {
                try {
                    const b64 = Buffer.from(response.data).toString('base64');
                    const body = {
                        contents: [{ role: "user", parts: [
                            { text: "Transcribe TODO el contenido textual de este PDF educativo: definiciones, fórmulas, ejemplos, tablas, datos. Conserva el orden. NO resumas — quiero el texto completo y limpio." },
                            { inline_data: { mime_type: "application/pdf", data: b64 } }
                        ]}],
                        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
                    };
                    const resp = await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
                        body, { headers: { "Content-Type": "application/json" }, timeout: 90000 }
                    );
                    const txt = resp.data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim();
                    if (txt && txt.length > 100) { console.log(`✅ PDF Gemini Vision: ${txt.length} chars`); return txt; }
                } catch(e) { console.log("PDF Gemini Vision falló:", e.message); }
            }
        }
        if (ct.includes("text/html") || ct.includes("application/xhtml")) {
            const $ = cheerio.load(response.data.toString("utf-8"));
            $("script,style,nav,footer,aside,header,iframe,noscript,.ad,.ads,.sidebar,.menu,.cookie,.popup,.modal,.banner,.paywall").remove();
            for (const sel of ["article","[role=main]","main",".article-body",".post-content",".entry-content",".content","#content","#main"]) {
                const txt = $(sel).text().replace(/\s+/g," ").trim();
                if (txt.length > 400) { console.log(`✅ Cheerio (${sel}): ${txt.length} chars`); return txt; }
            }
            const fb = $("h1,h2,h3,h4,p,li,td,th,blockquote").text().replace(/\s+/g," ").trim();
            if (fb.length > 200) return fb;
        }
    } catch(e) { console.log("Scraping falló:", e.message); }

    // 4. Wayback Machine
    try {
        const wb = await axios.get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeout: 8000 });
        const snap = wb.data?.archived_snapshots?.closest;
        if (snap?.url) {
            const ar = await axios.get(snap.url, { timeout: 20000, headers: { "User-Agent": "Mozilla/5.0" } });
            const $ = cheerio.load(ar.data);
            $("script,style,nav,footer,#wm-ipp,#wm-ipp-base").remove();
            const txt = $("article,main,p").text().replace(/\s+/g," ").trim();
            if (txt.length > 300) { console.log(`✅ Wayback: ${txt.length} chars`); return txt.substring(0, 20000); }
        }
    } catch {}

    throw new Error(`No se pudo leer: ${url}\n\n💡 Opciones:\n• Pega el texto directamente\n• Usa Wikipedia, Khan Academy o YouTube del mismo tema\n• Si es PDF, súbelo en "Foto/PDF"`);
}

// ── Verificación paralela de URLs por HEAD (filtra las que devuelven ≥400 o timeout)
async function verificarUrlsParalelo(urls, timeoutMs = 5000) {
    const pruebas = urls.map(u => axios.head(u, {
        timeout: timeoutMs,
        maxRedirects: 3,
        validateStatus: s => s < 400
    }).then(() => ({ url: u, ok: true }))
      .catch(() => ({ url: u, ok: false })));
    const resultados = await Promise.all(pruebas);
    return new Set(resultados.filter(r => r.ok).map(r => r.url));
}

// ── Búsqueda de recursos educativos con Gemini Grounding + verificación de URLs
async function buscarRecursosEducativosIA(tema) {
    if (!GEMINI_KEY) return null;
    try {
        const body = {
            contents: [{ role: "user", parts: [{ text:
`Busca recursos educativos REALES y actuales en español mexicano sobre: "${tema}"

FUENTES OBLIGATORIAS (usa google_search):
1. Videos de YouTube de canales educativos confiables (Khan Academy, UNAM, IPN, TED-Ed en español, Kurzgesagt en español, Crash Course en español, Date un Vlog, Derivando, QuantumFracture, Math2Me, DW en español, BBC Mundo).
2. Artículos de fuentes serias (Wikipedia en español, Khan Academy, National Geographic, Britannica, gob.mx, UNAM, CONACYT, IPN).
3. PDFs o documentos académicos gratuitos si existen.

REGLAS ABSOLUTAS:
• PROHIBIDO inventar URLs. Solo devuelve URLs que vengan DIRECTAMENTE de resultados de google_search — si no tienes resultado seguro para una categoría, devuelve array vacío [].
• Los IDs de YouTube deben ser exactamente los de los resultados de búsqueda — nunca inventes un ID de 11 caracteres.
• No incluyas URLs con parámetros de tracking (?utm_, ?si=, ?feature=).
• Si dudas de una URL, omítela. Es mejor un array pequeño y correcto que uno grande con enlaces rotos.

Responde SOLO con este JSON exacto:
{"videos":[{"titulo":"...","url":"https://youtube.com/watch?v=XXXXXXXXXXX","canal":"...","descripcion":"...","duracion":"..."}],"articulos":[{"titulo":"...","url":"https://...","fuente":"...","descripcion":"..."}],"consultas_sugeridas":["...","...","..."]}`
            }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.15, maxOutputTokens: 2048, responseMimeType: "application/json" }
        };
        const resp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
            body, { headers: { "Content-Type": "application/json" }, timeout: 45000 }
        );
        const texto = resp.data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim();
        if (!texto) return null;
        const data = JSON.parse(texto.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim());

        // Verificación paralela HEAD: filtra URLs rotas
        const todasUrls = [
            ...(data.videos || []).map(v => v.url).filter(Boolean),
            ...(data.articulos || []).map(a => a.url).filter(Boolean)
        ];
        if (todasUrls.length) {
            const validas = await verificarUrlsParalelo(todasUrls, 5000);
            data.videos    = (data.videos || []).filter(v => validas.has(v.url));
            data.articulos = (data.articulos || []).filter(a => validas.has(a.url));
            console.log(`✅ Recursos verificados: ${data.videos.length} videos + ${data.articulos.length} artículos (de ${todasUrls.length} propuestos)`);
        }
        return data;
    } catch(e) { console.warn("Búsqueda recursos IA falló:", e.message); return null; }
}

// ── Generar clase directamente con búsqueda (cuando URL falla o es solo un tema)
async function generarDesdeTemaBuscado(temaOUrl, meta = {}) {
    if (!GEMINI_KEY) throw new Error("Se requiere GEMINI_API_KEY para búsqueda de contenido.");

    let tema = temaOUrl;
    try {
        const u = new URL(temaOUrl);
        const q = u.searchParams.get("q") || u.searchParams.get("search");
        tema = q || u.pathname.split("/").filter(Boolean).slice(-1)[0]?.replace(/[-_]/g," ") || temaOUrl;
    } catch {}

    console.log(`🔍 Generando con búsqueda para: "${tema}"`);

    const body = {
        contents: [{ role: "user", parts: [{ text:
`Eres un profesor de preparatoria mexicano experto. Usa Google Search para encontrar información REAL, actualizada y confiable sobre: "${tema}"

Debes obtener de las búsquedas:
- Definiciones precisas y actuales (verificadas contra 2+ fuentes)
- Conceptos clave del tema con ejemplos reales
- Datos históricos/científicos/sociales relevantes con cifras verificables
- Al menos 4 sub-temas importantes
- 2-4 fuentes confiables reales (Wikipedia, Khan Academy, UNAM, gob.mx, National Geographic, etc.)

Con esa información, crea una CLASE MAGISTRAL EXPANSIVA para preparatoria mexicana (14-18 años).

Estructura obligatoria del "resumen" (10 párrafos, 3500-4500 caracteres):
  1) Hook cotidiano mexicano. 2) Definición + 2 equivalencias. 3-6) Cuatro sub-temas con ejemplo mexicano. 7) Errores comunes. 8) Aplicaciones diarias. 9) Conexión con otras materias. 10) Cierre con pregunta abierta.
Usa <b>negritas</b> para conceptos y <br><br> entre párrafos. Prosa fluida, sin viñetas.

REGLAS:
- NO inventes fuentes ni URLs. Si no estás 100% seguro, omite la cifra.
- El "podcast" debe durar 500-700 palabras, tono locutor educativo mexicano.
- Incluye "glosario" (6-10 términos) y "ejemplosPracticos" (3 casos con solución).
- Las 6 preguntas del quiz deben cubrir niveles Bloom [recordar, comprender, aplicar, analizar, evaluar, crear].

Responde SOLO con este JSON (sin markdown, sin texto extra):
{"titulo":"...","abstract":"Gancho 2-3 oraciones","resumen":"10 párrafos con <b>...</b><br><br>...","podcast":"Guión 500-700 palabras","glosario":[{"termino":"...","definicion":"..."}],"ejemplosPracticos":[{"problema":"...","solucion_paso_a_paso":"..."}],"quiz":[{"p":"P1","o":["A","B","C","D"],"r":0,"bloom":"recordar"},{"p":"P2","o":["A","B","C","D"],"r":1,"bloom":"comprender"},{"p":"P3","o":["A","B","C","D"],"r":2,"bloom":"aplicar"},{"p":"P4","o":["A","B","C","D"],"r":3,"bloom":"analizar"},{"p":"P5","o":["A","B","C","D"],"r":0,"bloom":"evaluar"},{"p":"P6","o":["A","B","C","D"],"r":2,"bloom":"crear"}],"flashcards":[{"anverso":"T1","reverso":"Def. Ejemplo: ... Importancia: ..."},{"anverso":"T2","reverso":"..."},{"anverso":"T3","reverso":"..."},{"anverso":"T4","reverso":"..."},{"anverso":"T5","reverso":"..."},{"anverso":"T6","reverso":"..."},{"anverso":"T7","reverso":"..."},{"anverso":"T8","reverso":"..."}],"fuentes":["Nombre fuente 1 (tipo)","Nombre fuente 2 (tipo)"]}`
        }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 16384, responseMimeType: "application/json" },
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }]
    };

    const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
        body, { headers: { "Content-Type": "application/json" }, timeout: 120000 }
    );
    const usage = resp.data.usageMetadata || {};
    if (mongoose.connection.readyState) {
        UsageLog.create({ ...meta, tipo: meta.tipo||"estudiar", modelo: GEMINI_MODEL+"-search",
            tokensInput: usage.promptTokenCount||0, tokensOutput: usage.candidatesTokenCount||0,
            tokensTotal: (usage.promptTokenCount||0)+(usage.candidatesTokenCount||0),
            costoUSD: ((usage.promptTokenCount||0)*0.000000075)+((usage.candidatesTokenCount||0)*0.0000003)
        }).catch(()=>{});
    }
    const texto = resp.data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim();
    if (!texto) throw new Error("Gemini no retornó contenido.");
    const data = JSON.parse(texto.replace(/```json\n?/g,"").replace(/```\n?/g,"").trim());
    data.contexto = `Generado con búsqueda sobre: "${tema}"`;
    data.generadaConBusqueda = true;
    return data;
}

const usageLogSchema = new mongoose.Schema({
    escuelaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Escuela', index: true, default: null },
    maestroId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true, default: null },
    tipo:         { type: String, enum: ['estudiar','chat','recursos','tarea','examen'], default: 'estudiar' },
    modelo:       String,
    tokensInput:  { type: Number, default: 0 },
    tokensOutput: { type: Number, default: 0 },
    tokensTotal:  { type: Number, default: 0 },
    costoUSD:     { type: Number, default: 0 }, // estimado
    creadoEn:     { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 } // 90 días TTL
});
const UsageLog = mongoose.models.UsageLog || mongoose.model('UsageLog', usageLogSchema);

// ── Procesador IA principal — clase magistral completa
async function procesarConIA(sourceText, meta = {}) {
    // sourceText puede ser string o {texto, videoId, esVideo, titulo}
    const esVideo = typeof sourceText === 'object' && sourceText.esVideo;
    const videoId = esVideo ? sourceText.videoId : null;
    const texto   = esVideo ? sourceText.texto : sourceText;

    if (!texto || texto.length < 30)
        throw new Error("No se encontró suficiente texto para analizar.");

    const contextoTipo = esVideo
        ? `Video educativo de YouTube (ID: ${videoId})`
        : 'Texto/artículo educativo';

    const messages = [
        {
            role: 'system',
            content: `Eres un profesor universitario mexicano de élite (perfil UNAM/Tec/IPN), apasionado, riguroso y con 15 años de experiencia frente a grupo. Dominas pedagogía basada en la taxonomía de Bloom (revisada, Anderson 2001), diseñas clases memorables y usas contexto mexicano real, contemporáneo y diverso (vida cotidiana, cultura pop, ciencia, deporte, política, tecnología). Tu objetivo es enseñar con profundidad — NO resumir Wikipedia, NO repetir definiciones de libro, NO listar hechos sueltos. SINTETIZAS: explicas el "por qué" detrás de los conceptos, conectas ideas, das ejemplos originales que solo un experto del tema daría. Respondes ÚNICAMENTE con JSON válido y bien formado — sin texto adicional, sin bloques de código, sin markdown fuera de las <b> permitidas en el campo "resumen".

CALIDAD INNEGOCIABLE:
- Profundidad sobre superficie: cada párrafo debe enseñar algo que NO es obvio.
- Originalidad: ejemplos contemporáneos (2020s+) que un estudiante reconozca de su realidad.
- Pensamiento crítico: cuando haya controversia o matices, los explicas (no los aplanas).
- Cero relleno tipo "como podemos ver", "en conclusión", "es importante saber". Vas al grano con sustancia.
- Si la fuente es pobre, EXPANDES con conocimiento experto verificado del tema; nunca produces clases vacías.`
        },
        {
            role: 'user',
            content: `Fuente: ${contextoTipo}

Transforma el contenido en una CLASE MAGISTRAL EXPANSIVA para estudiantes mexicanos de preparatoria (14-18 años). La clase debe sentirse como la mejor que han tenido: rica, clara, con ejemplos reales y sintetizada con criterio experto. NUNCA debe parecer un resumen de Wikipedia ni una lista de bullets disfrazada.

ESTRUCTURA OBLIGATORIA DEL "resumen" (mínimo 10 párrafos, 3800-5000 caracteres totales):
  Párrafo 1 — HOOK: abre con una escena/pregunta provocadora del contexto del estudiante (TikTok, fútbol, narcoseries, IA, redes, cocina mexicana, tráfico de CDMX/MTY/GDL/TJ, etc.). Sin clichés.
  Párrafo 2 — DEFINICIÓN formal del concepto principal + 2 sinónimos/formulaciones + 1 contraste con un concepto que se confunde fácilmente.
  Párrafos 3-6 — CUATRO SUB-TEMAS desarrollados con profundidad. Cada uno: explica el mecanismo/lógica interna + ejemplo concreto mexicano contemporáneo + por qué ese ejemplo lo ilustra. NO solo enuncies hechos: explícalos.
  Párrafo 7 — ERRORES COMUNES y misconcepciones específicas que cometen los estudiantes (no genéricos: dilo con detalle, "muchos confunden X con Y porque...").
  Párrafo 8 — APLICACIONES reales: 3 dominios distintos (vida personal, profesional, social/colectivo) con ejemplos específicos.
  Párrafo 9 — CONEXIÓN cruzada con OTRAS 2-3 materias (no genérico: "se relaciona con la física en el fenómeno X que veremos así...").
  Párrafo 10 — CIERRE motivador + 1 pregunta abierta tipo Bloom-evaluar/crear que invite a aplicar.
  Usa <b>negritas</b> para conceptos clave (4-8 por párrafo) y <br><br> entre párrafos. Prosa fluida, sin viñetas, sin emojis dentro del resumen.

OTROS CAMPOS:
• "podcast": guión conversacional de 600-850 palabras, en tono de locutor de radio educativa mexicana (usa "imagina que...", "piénsalo así...", "¿te ha pasado que...?", "ojo aquí"). Pausas naturales, transiciones claras, una analogía memorable, un dato sorprendente real. Diseñado para escucharse en TTS — sin asteriscos ni símbolos raros.
• "abstract": 2-3 oraciones gancho concretas: qué aprenderás + por qué cambia tu forma de ver algo.
• "glosario": 8-12 términos. Cada definición debe ser 1 oración precisa + 1 ejemplo de uso (no enciclopédico).
• "ejemplosPracticos": 3 objetos {problema, solucion_paso_a_paso}. Problemas REALISTAS (no "Juan tiene 5 manzanas"). Solución en 4-6 pasos numerados, cada paso explicando el porqué del paso, no solo el qué.
• "quiz": 6 preguntas distribuidas por nivel Bloom: [recordar, comprender, aplicar, analizar, evaluar, crear]. Añade campo "bloom". Los 4 distractores deben ser errores plausibles que un estudiante real cometería (NO absurdos, NO obviamente falsos). Índice "r" basado en 0. Cada pregunta incluye "explicacion": 2-3 frases que (a) por qué la correcta lo es, (b) qué confusión específica evita, (c) qué intuición fortalece.
• "flashcards": 8 tarjetas. Reverso con: definición precisa (1 línea) + ejemplo concreto y específico + 1 frase de "por qué importa" o "cómo lo usas".
• "fuentes": 3-5 referencias REALES y verificables del tema (libro/autor, paper clásico, recurso académico mexicano, documental, sitio institucional como UNAM/IPN/CONACYT). NO inventes URLs ni autores.

FORMATO JSON EXACTO (SOLO JSON):
{
  "titulo": "Título atractivo y específico",
  "abstract": "2-3 oraciones gancho.",
  "resumen": "Párrafo 1 <b>concepto</b>...<br><br>Párrafo 2...<br><br>... (10 párrafos, 3500-4500 chars)",
  "podcast": "Guión conversacional 500-700 palabras.",
  "glosario": [
    {"termino": "T1", "definicion": "..."},
    {"termino": "T2", "definicion": "..."}
  ],
  "ejemplosPracticos": [
    {"problema": "...", "solucion_paso_a_paso": "1) ... 2) ... 3) ..."},
    {"problema": "...", "solucion_paso_a_paso": "..."},
    {"problema": "...", "solucion_paso_a_paso": "..."}
  ],
  "quiz": [
    {"p": "Pregunta nivel recordar", "o": ["A","B","C","D"], "r": 0, "bloom": "recordar", "explicacion": "La opción A es correcta porque..."},
    {"p": "Pregunta nivel comprender", "o": ["A","B","C","D"], "r": 1, "bloom": "comprender", "explicacion": "La opción B es correcta porque..."},
    {"p": "Pregunta nivel aplicar", "o": ["A","B","C","D"], "r": 2, "bloom": "aplicar", "explicacion": "La opción C es correcta porque..."},
    {"p": "Pregunta nivel analizar", "o": ["A","B","C","D"], "r": 3, "bloom": "analizar", "explicacion": "La opción D es correcta porque..."},
    {"p": "Pregunta nivel evaluar", "o": ["A","B","C","D"], "r": 0, "bloom": "evaluar", "explicacion": "La opción A es correcta porque..."},
    {"p": "Pregunta nivel crear", "o": ["A","B","C","D"], "r": 2, "bloom": "crear", "explicacion": "La opción C es correcta porque..."}
  ],
  "flashcards": [
    {"anverso": "Término 1", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 2", "reverso": "..."},
    {"anverso": "Término 3", "reverso": "..."},
    {"anverso": "Término 4", "reverso": "..."},
    {"anverso": "Término 5", "reverso": "..."},
    {"anverso": "Término 6", "reverso": "..."},
    {"anverso": "Término 7", "reverso": "..."},
    {"anverso": "Término 8", "reverso": "..."}
  ],
  "fuentes": ["Fuente 1 (tipo)", "Fuente 2 (tipo)"]${esVideo ? ',\n  "videoId": "' + videoId + '"' : ''}
}

REGLAS CRÍTICAS DE CALIDAD:
- Si el contenido fuente es corto, débil o erróneo, EXPANDE/CORRIGE con conocimiento experto verificado del tema. NO produzcas placeholders, lorem-ipsum, ni "este tema es importante porque...".
- NO inventes datos, fechas, estadísticas ni autores específicos si no tienes certeza. Usa "aproximadamente", "diversos estudios sugieren", o reformula sin la cifra dudosa.
- NO copies frases textuales de Wikipedia ni de la fuente; sintetiza con tus propias palabras de profesor experto.
- Mantén español mexicano natural y vivo (sin españolismos como "vale", "guay", "ordenador", "móvil"). Usa "celular", "computadora", "OK", "está padre" si es natural — pero sin sobre-mexicanizar.
- Cada ejemplo mexicano debe ser ESPECÍFICO (no "como en muchos lugares de México" — di "como en el metro Pino Suárez en hora pico").
- Las explicaciones del quiz deben enseñar, no solo confirmar. Un estudiante que falla debe aprender algo nuevo al leerlas.

CONTENIDO FUENTE:
${texto.substring(0, 30000)}`
        }
    ];

    const text = await iaCall(messages, true, { ...meta, tipo: 'estudiar' });

    let data;
    try {
        // Limpiar posible markdown de Gemini
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        data = JSON.parse(clean);
    } catch(e) {
        // Intentar extraer JSON del texto
        const jsonMatch = text.match(/\{[\s\S]+\}/);
        if (jsonMatch) data = JSON.parse(jsonMatch[0]);
        else throw new Error('La IA retornó formato inválido. Intenta de nuevo.');
    }

    data.contexto = texto.substring(0, 10000);
    data.quiz = normalizeQuestions(data.quiz || []);
    if (videoId) data.videoId = videoId;
    return data;
}

// ── Procesador IA para Tarea — genera pool de 15 preguntas + abstract + rubrica
async function procesarConIAPool(sourceText, meta = {}) {
    if (!sourceText || sourceText.length < 50)
        throw new Error("No se encontró suficiente texto para analizar.");

    const materia = meta.materia ? String(meta.materia) : '';
    const semestre = meta.semestre ? String(meta.semestre) : '';
    const contextoMateria = (materia || semestre)
        ? `Especialización: ${materia || 'general'}${semestre ? ' — ' + semestre : ''} de preparatoria mexicana. Adapta vocabulario, profundidad y ejemplos a ese nivel.`
        : '';

    const messages = [
        {
            role: 'system',
            content: `Eres un profesor universitario mexicano de élite (perfil UNAM/Tec/IPN), apasionado y riguroso, especialista en evaluación auténtica. Diseñas material de altísima calidad — NO Wikipedia, NO listas de hechos, NO definiciones de libro. SINTETIZAS con criterio experto, conectas conceptos, y construyes distractores que reflejan los errores reales de aula que los estudiantes mexicanos cometen. ${contextoMateria} Respondes ÚNICAMENTE con JSON válido y bien formado — sin texto adicional, sin markdown fuera de <b> en "resumen".

CALIDAD INNEGOCIABLE:
- Profundidad sobre superficie. Cada elemento enseña algo no obvio.
- Ejemplos contemporáneos (2020s) y específicos (no genéricos).
- Distractores plausibles que reflejen confusiones reales — NUNCA absurdos.
- Si la fuente es pobre, expandes con conocimiento experto verificado del tema.`
        },
        {
            role: 'user',
            content: `Crea material completo de estudio + pool de preguntas para una tarea asignada por el maestro. Calidad de profesor experto, NO de Wikipedia.

ESTRUCTURA OBLIGATORIA DEL "resumen" (10 párrafos, 3800-5000 caracteres):
  1) Hook con escena/pregunta cotidiana mexicana específica (no genérica). 2) Definición formal + 2 equivalencias + 1 contraste con concepto que se confunde. 3-6) Cuatro sub-temas desarrollados con profundidad: mecanismo + ejemplo mexicano específico + por qué ese ejemplo lo ilustra. 7) Errores comunes específicos de estudiantes ("muchos confunden X con Y porque..."). 8) 3 aplicaciones diarias en dominios distintos. 9) Conexión cruzada con 2-3 otras materias. 10) Cierre + pregunta abierta tipo Bloom-evaluar/crear.
  Usa <b>negritas</b> (4-8 por párrafo) y <br><br>. Prosa fluida, sin viñetas, sin emojis dentro del resumen.

OTROS CAMPOS:
• "abstract": 2-3 oraciones gancho concretas (qué aprenderás + por qué cambia tu forma de ver algo).
• "podcast": guión conversacional 600-850 palabras, tono de locutor educativo mexicano vivo (transiciones naturales, una analogía memorable, un dato sorprendente real).
• "glosario": 8-12 términos. Cada definición = 1 oración precisa + 1 ejemplo de uso.
• "ejemplosPracticos": 3 objetos {problema, solucion_paso_a_paso (4-6 pasos)}. Problemas REALISTAS, cada paso explica el porqué — no solo el qué.
• "poolPreguntas" (EXACTAMENTE 15): distribución estricta:
    - Preguntas 1-5: nivel BÁSICO (Bloom: recordar, comprender)
    - Preguntas 6-10: nivel INTERMEDIO (Bloom: aplicar, analizar)
    - Preguntas 11-15: nivel AVANZADO (Bloom: evaluar, crear)
    REGLAS DURAS:
    ▸ Cada una de las 15 preguntas cubre un CONCEPTO DISTINTO. Prohibido preguntar dos veces lo mismo.
    ▸ Los 3 distractores son errores comunes reales (confusiones típicas, inversiones de relación causa-efecto, definiciones incompletas) — NUNCA absurdos ni obviamente falsos.
    ▸ Las 4 opciones tienen longitud similar (±20%). No hagas la respuesta correcta más larga.
    ▸ Prohibido repetir la misma estructura gramatical en 2 preguntas consecutivas.
    ▸ Nunca uses "ninguna de las anteriores" ni "todas las anteriores".
    ▸ Añade un campo "bloom" con el nivel específico.
    ▸ Añade un campo "explicacion" en cada pregunta: 1-2 frases didácticas que expliquen por qué la respuesta correcta es correcta y cuál es el error común detrás de los distractores.
• "flashcards" (8): anverso=término, reverso=definición precisa + ejemplo concreto + por qué importa.
• "rubrica" (3 criterios): para evaluación escrita. Cada criterio con 4 niveles {nivel, descripcion}.

FORMATO JSON EXACTO:
{
  "titulo": "Título atractivo y específico",
  "abstract": "Gancho 2-3 oraciones.",
  "resumen": "10 párrafos con <b>negritas</b> y <br><br>...",
  "podcast": "Guión 500-700 palabras.",
  "glosario": [{"termino":"T1","definicion":"..."}, ...],
  "ejemplosPracticos": [{"problema":"...","solucion_paso_a_paso":"1) ... 2) ..."}, ...],
  "poolPreguntas": [
    {"p":"P1 básica","o":["A","B","C","D"],"r":0,"bloom":"recordar","explicacion":"La opción A es correcta porque..."},
    {"p":"P2 básica","o":["A","B","C","D"],"r":1,"bloom":"recordar","explicacion":"La opción B es correcta porque..."},
    {"p":"P3 básica","o":["A","B","C","D"],"r":2,"bloom":"comprender","explicacion":"La opción C es correcta porque..."},
    {"p":"P4 básica","o":["A","B","C","D"],"r":3,"bloom":"comprender","explicacion":"La opción D es correcta porque..."},
    {"p":"P5 básica","o":["A","B","C","D"],"r":0,"bloom":"comprender","explicacion":"La opción A es correcta porque..."},
    {"p":"P6 intermedia","o":["A","B","C","D"],"r":1,"bloom":"aplicar","explicacion":"La opción B es correcta porque..."},
    {"p":"P7 intermedia","o":["A","B","C","D"],"r":2,"bloom":"aplicar","explicacion":"La opción C es correcta porque..."},
    {"p":"P8 intermedia","o":["A","B","C","D"],"r":3,"bloom":"analizar","explicacion":"La opción D es correcta porque..."},
    {"p":"P9 intermedia","o":["A","B","C","D"],"r":0,"bloom":"analizar","explicacion":"La opción A es correcta porque..."},
    {"p":"P10 intermedia","o":["A","B","C","D"],"r":1,"bloom":"analizar","explicacion":"La opción B es correcta porque..."},
    {"p":"P11 avanzada","o":["A","B","C","D"],"r":2,"bloom":"evaluar","explicacion":"La opción C es correcta porque..."},
    {"p":"P12 avanzada","o":["A","B","C","D"],"r":3,"bloom":"evaluar","explicacion":"La opción D es correcta porque..."},
    {"p":"P13 avanzada","o":["A","B","C","D"],"r":0,"bloom":"crear","explicacion":"La opción A es correcta porque..."},
    {"p":"P14 avanzada","o":["A","B","C","D"],"r":1,"bloom":"crear","explicacion":"La opción B es correcta porque..."},
    {"p":"P15 avanzada","o":["A","B","C","D"],"r":2,"bloom":"crear","explicacion":"La opción C es correcta porque..."}
  ],
  "flashcards": [
    {"anverso":"T1","reverso":"Definición. Ejemplo: ... Importancia: ..."},
    {"anverso":"T2","reverso":"..."}, {"anverso":"T3","reverso":"..."},
    {"anverso":"T4","reverso":"..."}, {"anverso":"T5","reverso":"..."},
    {"anverso":"T6","reverso":"..."}, {"anverso":"T7","reverso":"..."},
    {"anverso":"T8","reverso":"..."}
  ],
  "rubrica": [
    {"criterio":"Comprensión del tema","niveles":[
      {"nivel":"Excelente","descripcion":"..."},{"nivel":"Bueno","descripcion":"..."},
      {"nivel":"Suficiente","descripcion":"..."},{"nivel":"Insuficiente","descripcion":"..."}]},
    {"criterio":"Uso de ejemplos y evidencia","niveles":[
      {"nivel":"Excelente","descripcion":"..."},{"nivel":"Bueno","descripcion":"..."},
      {"nivel":"Suficiente","descripcion":"..."},{"nivel":"Insuficiente","descripcion":"..."}]},
    {"criterio":"Claridad y redacción","niveles":[
      {"nivel":"Excelente","descripcion":"..."},{"nivel":"Bueno","descripcion":"..."},
      {"nivel":"Suficiente","descripcion":"..."},{"nivel":"Insuficiente","descripcion":"..."}]}
  ]
}

CONTENIDO FUENTE:
${sourceText.substring(0, 30000)}`
        }
    ];

    const text = await iaCall(messages, true, { ...meta, tipo: 'tarea' });
    try {
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        const data = JSON.parse(clean);
        data.poolPreguntas = normalizeQuestions(data.poolPreguntas || data.quiz || []);
        return data;
    } catch(e) {
        const jsonMatch = text.match(/\{[\s\S]+\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            data.poolPreguntas = normalizeQuestions(data.poolPreguntas || data.quiz || []);
            return data;
        }
        throw new Error('La IA retornó formato inválido. Intenta de nuevo.');
    }
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
app.post('/api/estudiar', rateLimit(15, 60_000), verifyAlumno, checkLimiteDiario, async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        const meta = { alumnoId: req.alumno?.id, tipo: 'estudiar' };
        let fuente = input.trim();

        if (fuente.startsWith('http')) {
            try {
                // Intentar extraer el contenido de la URL
                fuente = await extraerTextoWeb(fuente);
            } catch(extractErr) {
                console.warn('Extracción falló, intentando generar con búsqueda:', extractErr.message);
                // Si la URL falla, generar directamente con Gemini Grounding
                if (GEMINI_KEY) {
                    const data = await generarDesdeTemaBuscado(input.trim(), meta);
                    return res.json(data);
                }
                return res.status(422).json({ error: extractErr.message });
            }
        }

        res.json(await procesarConIA(fuente, meta));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/estudiar-archivo', verifyAlumno, checkLimiteDiario, upload.array('archivos', 10), async (req, res) => {
    const archivos = req.files || [];
    const tmpPaths = archivos.map(f => f.path);
    try {
        if (!archivos.length) return res.status(400).json({ error: 'No se recibieron archivos.' });
        let textoTotal = '';

        for (const archivo of archivos) {
            const buf  = await readFile(archivo.path);
            const mime = archivo.mimetype;
            let texto  = '';
            if      (mime === 'application/pdf')  { try { texto = (await pdfParse(buf)).text; } catch {} }
            else if (mime.startsWith('image/'))    { texto = await extractImageText(buf, mime); }
            else                                   { texto = buf.toString('utf-8'); }
            if (texto.trim()) textoTotal += texto + '\n\n';
        }

        if (!textoTotal.trim() || textoTotal.trim().length < 30)
            throw new Error('No se encontró suficiente texto en los archivos.');

        res.json(await procesarConIA(textoTotal, { alumnoId: req.alumno?.id, tipo: 'estudiar' }));
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { for (const p of tmpPaths) await unlink(p).catch(() => {}); }
});

// ══ CHAT ALUMNO — contexto completo de la clase ══
app.post('/api/chat', rateLimit(40, 60_000), async (req, res) => {
    try {
        const { context, question: rawQuestion, sesionData, historial } = req.body;
        const question = sanitizeChatInput(rawQuestion);
        if (!question) return res.status(400).json({ error: 'Falta la pregunta.' });

        let contextoCompleto = '';
        if (sesionData) {
            const { titulo, resumen, flashcards, quiz, podcast } = sesionData;
            contextoCompleto = [
                `TEMA: ${titulo || ''}`,
                resumen ? `CLASE:\n${resumen.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,4000)}` : '',
                flashcards?.length ? `CONCEPTOS:\n${flashcards.map(f=>`• ${f.anverso}: ${f.reverso||f.definicion||''}`).join('\n')}` : '',
                quiz?.length ? `QUIZ (respuestas):\n${quiz.map((q,i)=>`${i+1}. ${q.p} → ${q.o?.[q.r]||''}`).join('\n')}` : '',
                podcast ? `PODCAST:\n${podcast.substring(0,800)}` : ''
            ].filter(Boolean).join('\n\n');
        } else if (context) {
            contextoCompleto = context.substring(0, 5000);
        }
        const guard = chatGuardrail('alumno', question, !!contextoCompleto);
        if (!guard.ok) return res.json({ answer: guard.answer, guardrail: true });

        const histMsgs = (historial||[]).slice(-10).map(m=>({ role: m.role==='user'?'user':'assistant', content: m.texto }));

        const messages = [
            { role: 'system', content: `Eres un tutor inteligente para preparatoria. Tienes acceso al material completo de la clase que el alumno estudió.

REGLAS ESTRICTAS:
- Solo responde preguntas RELACIONADAS con el material de la clase o temas educativos de preparatoria
- Si te preguntan algo fuera del tema (redes sociales, política, entretenimiento), redirige amablemente: "Enfoquémonos en [TEMA]..."
- Usa el material de la clase para dar respuestas específicas y precisas
- Si el alumno se equivoca, corrígelo con amabilidad y explica por qué
- Máximo 3 párrafos, usa emojis con moderación
- Habla en español mexicano natural

${contextoCompleto ? `\n=== MATERIAL DE LA CLASE ===\n${contextoCompleto}\n=== FIN ===` : '\nNota: No hay clase activa, responde preguntas generales educativas de preparatoria.'}` },
            ...histMsgs,
            { role: 'user', content: question }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat' });
        res.json({ answer });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ CHAT MAESTRO — SOLO datos internos del grupo ══
app.post('/api/maestro/chat', rateLimit(40, 60_000), verifyToken, async (req, res) => {
    try {
        const { grupoId, pregunta: rawPreg, historial } = req.body;
        const pregunta = sanitizeChatInput(rawPreg);
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });
        const guard = chatGuardrail('maestro', pregunta, true);
        if (!guard.ok) return res.json({ answer: guard.answer, guardrail: true });

        // Construir contexto completo y real del grupo
        let contextoGrupo = 'No se seleccionó grupo. Solo puedes dar consejos generales sobre pedagogía.';
        let nombreGrupo = '';

        if (grupoId && mongoose.connection.readyState) {
            const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id }).select('nombre semestre materia');
            if (grupo) {
                nombreGrupo = grupo.nombre;
                const sesiones = await Sesion.find({ grupoId })
                    .sort({ creadoEn: -1 }).select('nombre pct correctas total creadoEn hora respuestasQuiz escuchoPodcast tareaId').lean().limit(300);
                const tareas = await Tarea.find({ grupoId, maestroId: req.maestro.id }).select('titulo shortId creadoEn').lean().limit(20);

                const hace7 = new Date(Date.now() - 7*24*60*60*1000);
                // Construir mapa por alumno
                const alumnosMap = {};
                sesiones.forEach(s => {
                    if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = { sesiones:[], pcts:[] };
                    alumnosMap[s.nombre].sesiones.push(s);
                    alumnosMap[s.nombre].pcts.push(s.pct||0);
                });

                const alumnosResumen = Object.entries(alumnosMap).map(([nombre, a]) => {
                    const prom = Math.round(a.pcts.reduce((x,y)=>x+y,0)/a.pcts.length);
                    const sem  = a.sesiones.filter(s=>new Date(s.creadoEn)>=hace7).length;
                    const ult  = a.sesiones[0];
                    const diask = ult ? Math.floor((Date.now()-new Date(ult.creadoEn))/86400000) : 999;
                    const trend = a.pcts.length>=3 ? a.pcts[0]-a.pcts[Math.min(2,a.pcts.length-1)] : 0;
                    return `  • ${nombre}: promedio=${prom}%, sesiones=${a.sesiones.length}, estaSemana=${sem}, diasInactivo=${diask}, tendencia=${trend>=5?'⬆️sube':trend<=-5?'⬇️baja':'➡️estable'}`;
                }).sort((a,b) => {
                    const pa = parseInt(a.match(/promedio=(\d+)/)?.[1]||0);
                    const pb = parseInt(b.match(/promedio=(\d+)/)?.[1]||0);
                    return pb-pa;
                });

                const fallosMap = {};
                sesiones.forEach(s=>(s.respuestasQuiz||[]).forEach(r=>{
                    if (!r.esCorrecta && r.pregunta) fallosMap[r.pregunta] = (fallosMap[r.pregunta]||0)+1;
                }));
                const topFallos = Object.entries(fallosMap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([p,v])=>`  • "${p.substring(0,60)}" — fallada ${v} veces`);

                const promGeneral = sesiones.length ? Math.round(sesiones.reduce((a,s)=>a+(s.pct||0),0)/sesiones.length) : 0;
                const semanaTotal = sesiones.filter(s=>new Date(s.creadoEn)>=hace7).length;

                contextoGrupo = `GRUPO: ${grupo.nombre} | ${grupo.materia} | ${grupo.semestre}
RESUMEN: promedio=${promGeneral}%, totalEntregas=${sesiones.length}, estaSemana=${semanaTotal}, alumnos=${alumnosResumen.length}
TAREAS CREADAS: ${tareas.map(t=>t.titulo).join(', ')||'ninguna'}

ALUMNOS:
${alumnosResumen.join('\n')||'Sin alumnos registrados aún'}

CONCEPTOS MÁS FALLADOS:
${topFallos.join('\n')||'Sin datos suficientes'}`;
            }
        }

        const histMsgs = (historial||[]).slice(-8).map(m=>({ role: m.role==='maestro'?'user':'assistant', content: m.texto }));

        const messages = [
            { role: 'system', content: `Eres un asistente pedagógico para maestros de preparatoria. Tu función es analizar los datos REALES del grupo y dar recomendaciones accionables.

REGLAS ESTRICTAS:
- SOLO habla de lo que hay en los datos del grupo. Si no hay datos, dilo claramente.
- NUNCA inventes alumnos, calificaciones o estadísticas que no estén en los datos
- Da recomendaciones específicas con nombres reales de alumnos cuando los tengas
- Si preguntan algo fuera del ámbito pedagógico, declina amablemente
- Respuestas concisas: máximo 4 puntos o 3 párrafos cortos
- Idioma: español mexicano

DATOS REALES DEL GRUPO:
${contextoGrupo}` },
            ...histMsgs,
            { role: 'user', content: pregunta }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat', maestroId: req.maestro.id });
        res.json({ answer });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ CHAT DIRECTOR — con contexto real de la institución ══
app.post('/api/director/chat', rateLimit(40, 60_000), verifyDirector, async (req, res) => {
    try {
        const { pregunta: rawPreg, historial } = req.body;
        const pregunta = sanitizeChatInput(rawPreg);
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });
        const guard = chatGuardrail('director', pregunta, true);
        if (!guard.ok) return res.json({ answer: guard.answer, guardrail: true });

        // Datos REALES de la institución del director (no de toda la BD)
        const escuelaId = req.director.escuelaId;
        let ctx = 'Sin datos disponibles aún.';

        if (mongoose.connection.readyState && escuelaId) {
            const hace30 = new Date(Date.now()-30*24*60*60*1000);
            const hace7  = new Date(Date.now()-7*24*60*60*1000);
            const hoy    = new Date(new Date().setHours(0,0,0,0));

            const maestros   = await Maestro.find({ escuelaId }).select('nombre email').lean();
            const maestroIds = maestros.map(m => m._id);
            const grupos     = await Grupo.find({ maestroId: { $in: maestroIds } }).select('nombre materia semestre').lean();
            const grupoIds   = grupos.map(g => g._id);
            const alumnos    = await Alumno.find({ grupoId: { $in: grupoIds }, activo: true }).select('nombre grupoId logros').lean();

            const [ses30, ses7, sesToday] = await Promise.all([
                Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace30 } }),
                Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace7 } }),
                Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hoy } })
            ]);

            const muestra = await Sesion.find({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace30 } })
                .select('nombre pct creadoEn grupoId').lean().limit(600);
            const prom = muestra.length ? Math.round(muestra.reduce((a,s)=>a+(s.pct||0),0)/muestra.length) : 0;

            // Riesgo: alumnos con promedio <60 en últimas 3 sesiones
            const alumMap = {};
            muestra.forEach(s => { if(!alumMap[s.nombre]) alumMap[s.nombre]=[]; alumMap[s.nombre].push(s.pct||0); });
            const riesgo = Object.entries(alumMap)
                .filter(([,ps])=>ps.length>=2 && ps.slice(0,3).reduce((a,b)=>a+b,0)/Math.min(3,ps.length)<60)
                .map(([n,ps])=>`${n}(${Math.round(ps.slice(0,3).reduce((a,b)=>a+b,0)/Math.min(3,ps.length))}%)`);

            // Maestros activos esta semana
            const maestrosActivos = await Promise.all(maestros.map(async m => {
                const gids = grupos.filter(g=>String(g.maestroId||'')===String(m._id)).map(g=>g._id);
                const cnt  = await Sesion.countDocuments({ grupoId:{$in:gids}, creadoEn:{$gte:hace7} });
                return { nombre: m.nombre, sesiones7d: cnt };
            }));
            const topMaestros = [...maestrosActivos].sort((a,b)=>b.sesiones7d-a.sesiones7d).slice(0,3);
            const sinActividad = maestrosActivos.filter(m=>m.sesiones7d===0).map(m=>m.nombre);

            ctx = `INSTITUCIÓN: ${await Escuela.findById(escuelaId).select('nombre').lean().then(e=>e?.nombre||'')}
MAESTROS: ${maestros.length} | GRUPOS: ${grupos.length} | ALUMNOS: ${alumnos.length}
SESIONES: hoy=${sesToday}, semana=${ses7}, mes30=${ses30}
PROMEDIO INSTITUCIONAL: ${prom}%
ALUMNOS EN RIESGO (<60%): ${riesgo.length} → ${riesgo.slice(0,8).join(', ')||'ninguno'}
MAESTROS MÁS ACTIVOS (7d): ${topMaestros.map(m=>`${m.nombre}(${m.sesiones7d} ses)`).join(', ')||'—'}
MAESTROS SIN ACTIVIDAD ESTA SEMANA: ${sinActividad.join(', ')||'ninguno'}
GRUPOS: ${grupos.map(g=>`${g.nombre}/${g.materia}`).join(', ')}`;
        }

        const histMsgs = (historial||[]).slice(-8).map(m=>({ role: m.role==='director'?'user':'assistant', content: m.texto }));

        const messages = [
            { role: 'system', content: `Eres un asistente estratégico exclusivo para el director de esta institución educativa. Solo tienes acceso a los datos de SU institución.

REGLAS:
- SOLO usa los datos proporcionados. NUNCA inventes métricas
- Si no hay datos suficientes, dilo claramente
- Respuestas ejecutivas: máx 4 puntos concisos
- Si preguntan algo ajeno al ámbito educativo-institucional, declina
- Propón acciones concretas con nombres reales cuando los tengas

DATOS REALES DE LA INSTITUCIÓN:
${ctx}` },
            ...histMsgs,
            { role: 'user', content: pregunta }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat' });
        res.json({ answer });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ PERFIL DEL ALUMNO ══
app.get('/api/alumno/perfil', verifyAlumno, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const alumno = await Alumno.findById(req.alumno.id)
            .select('-passwordHash -resetToken -resetTokenExp')
            .populate('grupoId', 'nombre semestre materia').lean();
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });

        const hace30 = new Date(Date.now() - 30*24*60*60*1000);
        const hace7  = new Date(Date.now() - 7*24*60*60*1000);
        const hoy    = new Date(new Date().setHours(0,0,0,0));

        // Traer sesiones del alumno desde MongoDB
        const sesiones = await Sesion.find({ nombre: { $regex: new RegExp(`^${alumno.nombre}$`, 'i') } })
            .sort({ creadoEn: -1 }).select('titulo pct correctas total fecha hora creadoEn tareaId').lean().limit(200);

        const totalSesiones = sesiones.length;
        const sesiones30d = sesiones.filter(s => new Date(s.creadoEn) >= hace30);
        const sesiones7d  = sesiones.filter(s => new Date(s.creadoEn) >= hace7);
        const sesionesHoy = sesiones.filter(s => new Date(s.creadoEn) >= hoy);
        const promedio    = totalSesiones ? Math.round(sesiones.reduce((a,s)=>a+(s.pct||0),0)/totalSesiones) : 0;

        // Calcular racha actual
        let rachaActual = 0;
        const diasConActividad = new Set(sesiones.map(s => new Date(s.creadoEn).toDateString()));
        const hoyStr = new Date().toDateString();
        let checkDate = new Date();
        while (diasConActividad.has(checkDate.toDateString())) {
            rachaActual++;
            checkDate.setDate(checkDate.getDate() - 1);
        }

        // Mejor sesión
        const mejor = sesiones.reduce((a, s) => s.pct > (a?.pct || 0) ? s : a, null);

        // Tareas asignadas y completadas
        let tareasAsignadas = [], tareasCompletadas = [], retosActivos = [];
        if (alumno.grupoId?._id) {
            tareasAsignadas = await Tarea.find({ grupoId: alumno.grupoId._id })
                .select('titulo abstract shortId creadoEn').sort({ creadoEn: -1 }).lean().limit(20);
            const tareasIds = tareasAsignadas.map(t => t.shortId);
            const sesionesConTarea = await Sesion.find({
                nombre: { $regex: new RegExp(`^${alumno.nombre}$`, 'i') },
                tareaId: { $in: tareasAsignadas.map(t => t._id) }
            }).select('tareaId pct').lean();
            const tareasCompletadasMap = {};
            sesionesConTarea.forEach(s => { if (s.tareaId) tareasCompletadasMap[s.tareaId.toString()] = s.pct; });
            tareasCompletadas = tareasCompletadasMap;

            // Retos activos del grupo del alumno
            try {
                retosActivos = await Reto.find({
                    grupoId: alumno.grupoId._id,
                    activo: true,
                    fechaFin: { $gte: new Date() }
                }).select('shortId titulo descripcion fechaFin tiempoLimite participantes').sort({ creadoEn: -1 }).lean().limit(10);
                // Marcar si el alumno ya participó
                retosActivos = retosActivos.map(r => {
                    const yo = (r.participantes || []).find(p => (p.alumno || '').toLowerCase() === (alumno.nombre || '').toLowerCase());
                    return {
                        shortId: r.shortId,
                        titulo: r.titulo,
                        descripcion: r.descripcion,
                        fechaFin: r.fechaFin,
                        tiempoLimite: r.tiempoLimite,
                        participantes: (r.participantes || []).length,
                        completado: !!yo,
                        miPct: yo?.pct || null
                    };
                });
            } catch(_) { retosActivos = []; }
        }

        // Logros
        const logros = (alumno.logros || []).map(id => ({
            id,
            emoji: ({ primera_sesion:'🎉', racha_3:'🔥', racha_7:'💫', racha_30:'🏆', perfecto:'⭐', perfecto_3:'✨',
                      sesiones_10:'📚', sesiones_50:'🎓', sesiones_100:'🌟', primer_examen:'📝', quiz_vivo:'⚡',
                      madrugador:'🌅', nocturno:'🌙', podcast:'🎧', flashcards:'🃏' })[id] || '🏅',
            titulo: id.replace(/_/g,' ')
        }));

        res.json({
            alumno: {
                nombre: alumno.nombre, email: alumno.email,
                grupo: alumno.grupoId || null,
                limiteDiario: alumno.limiteDiario || 10,
                creadoEn: alumno.creadoEn
            },
            stats: { totalSesiones, sesiones30d: sesiones30d.length, sesiones7d: sesiones7d.length,
                     sesionesHoy: sesionesHoy.length, promedio, rachaActual, mejor },
            sesionesRecientes: sesiones.slice(0, 20),
            tareasAsignadas: tareasAsignadas.map(t => ({
                ...t,
                completada: !!tareasCompletadas[t._id?.toString()],
                pct: tareasCompletadas[t._id?.toString()] || null
            })),
            retosActivos,
            logros
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ ANALYTICS DEL MAESTRO — tendencias, heatmap, alertas ══
app.get('/api/maestro/analytics/:grupoId', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupo = await Grupo.findOne({ _id: req.params.grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const hace30 = new Date(Date.now() - 30*24*60*60*1000);
        const hace7  = new Date(Date.now() - 7*24*60*60*1000);
        const sesiones = await Sesion.find({ grupoId: grupo._id, creadoEn: { $gte: hace30 } })
            .sort({ creadoEn: 1 }).select('nombre pct correctas total creadoEn hora escuchoPodcast').lean();

        // Progreso semanal por alumno (tendencia)
        const alumnosMap = {};
        sesiones.forEach(s => {
            if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = [];
            alumnosMap[s.nombre].push({ pct: s.pct||0, fecha: s.creadoEn });
        });

        const progresoPorAlumno = Object.entries(alumnosMap).map(([nombre, ss]) => {
            const semanas = [[], [], [], []];
            ss.forEach(s => {
                const dias = Math.floor((Date.now() - new Date(s.fecha)) / 86400000);
                const semIdx = Math.min(3, Math.floor(dias / 7));
                semanas[3 - semIdx].push(s.pct);
            });
            const promediosSemana = semanas.map(ss =>
                ss.length ? Math.round(ss.reduce((a,b)=>a+b,0)/ss.length) : null
            );
            const ultimas3 = ss.slice(-3).map(s => s.pct);
            const tendencia = ultimas3.length >= 2
                ? (ultimas3[ultimas3.length-1] - ultimas3[0] > 5 ? 'sube'
                : ultimas3[0] - ultimas3[ultimas3.length-1] > 5 ? 'baja' : 'estable')
                : 'sin datos';
            const diasDesdeUltima = ss.length ? Math.floor((Date.now() - new Date(ss[ss.length-1].fecha)) / 86400000) : 999;
            return { nombre, promediosSemana, tendencia, diasDesdeUltima, totalSesiones: ss.length };
        }).sort((a,b) => a.diasDesdeUltima - b.diasDesdeUltima);

        // Heatmap — sesiones por día de semana y hora
        const heatmap = Array.from({length:7}, () => Array(24).fill(0));
        sesiones.forEach(s => {
            const d = new Date(s.creadoEn);
            const diaSemana = d.getDay();
            const hora = d.getHours();
            heatmap[diaSemana][hora]++;
        });

        // Alertas automáticas
        const alertas = [];
        progresoPorAlumno.forEach(a => {
            if (a.diasDesdeUltima >= 5) alertas.push({
                tipo: 'inactividad', alumno: a.nombre,
                msg: `${a.nombre} lleva ${a.diasDesdeUltima} días sin estudiar`
            });
            if (a.tendencia === 'baja') alertas.push({
                tipo: 'caida', alumno: a.nombre,
                msg: `${a.nombre} tiene tendencia a la baja en sus últimas sesiones`
            });
        });

        // Sesiones por día (últimos 14 días)
        const sesionesPorDia = {};
        sesiones.forEach(s => {
            const d = new Date(s.creadoEn).toISOString().split('T')[0];
            sesionesPorDia[d] = (sesionesPorDia[d] || 0) + 1;
        });
        const diasLabels = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(Date.now() - i*86400000).toISOString().split('T')[0];
            diasLabels.push({ fecha: d, count: sesionesPorDia[d] || 0 });
        }

        res.json({
            grupo: { nombre: grupo.nombre, materia: grupo.materia, semestre: grupo.semestre },
            progresoPorAlumno,
            heatmap,
            alertas,
            sesionesPorDia: diasLabels,
            resumen: {
                totalSesiones: sesiones.length,
                promedio: sesiones.length ? Math.round(sesiones.reduce((a,s)=>a+(s.pct||0),0)/sesiones.length) : 0,
                alumnosActivos: Object.keys(alumnosMap).length,
                alumnosEnRiesgo: alertas.filter(a=>a.tipo==='inactividad').length
            }
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ BÚSQUEDA DE RECURSOS EDUCATIVOS — GEMINI GROUNDING ══
app.post('/api/maestro/recursos', verifyToken, async (req, res) => {
    try {
        const { tema } = req.body;
        if (!tema || tema.length < 3) return res.status(400).json({ error: 'Escribe un tema para buscar.' });

        // Intentar con Gemini Grounding primero (encuentra recursos REALES y actuales)
        if (GEMINI_KEY) {
            const recursos = await buscarRecursosEducativosIA(tema);
            if (recursos && (recursos.videos?.length || recursos.articulos?.length)) {
                // Construir respuesta compatible con el frontend
                const paraTarea = [];
                const materialExtra = [];

                (recursos.articulos || []).forEach(a => {
                    paraTarea.push({
                        titulo: a.titulo, fuente: a.fuente, tipo: 'Artículo',
                        nivel: 'Preparatoria', descripcion: a.descripcion,
                        url: a.url, idioma: 'Español', procesable: true,
                        esVideo: false, urlActiva: true
                    });
                });

                (recursos.videos || []).forEach(v => {
                    materialExtra.push({
                        titulo: v.titulo, fuente: v.canal || 'YouTube',
                        tipo: 'Video', nivel: 'Preparatoria',
                        descripcion: `${v.descripcion}${v.duracion ? ' · ' + v.duracion : ''}`,
                        url: v.url, idioma: 'Español', procesable: false,
                        esVideo: true, urlActiva: true
                    });
                });

                return res.json({
                    recursos: [...paraTarea, ...materialExtra],
                    paraTarea,
                    materialExtra,
                    consejo: `Recursos encontrados en tiempo real para "${tema}". Los artículos puedes procesarlos directamente en Tutor IA. Los videos son del tema exacto.`,
                    consultasSugeridas: recursos.consultas_sugeridas || [],
                    fuenteIA: 'google_search'
                });
            }
        }

        // Fallback: generación sin búsqueda (modo antiguo mejorado)
        const text = await iaCall([
            { role: 'system', content: 'Eres un experto en recursos educativos. Respondes ÚNICAMENTE con JSON válido.' },
            { role: 'user', content:
`Recursos educativos de ALTA CALIDAD para preparatoria en México sobre: "${tema}".

URLs SEGURAS solamente:
- Wikipedia: https://es.wikipedia.org/wiki/${encodeURIComponent(tema.replace(/ /g,'_'))}
- Khan Academy: https://es.khanacademy.org/search?page_search_query=${encodeURIComponent(tema)}
- YouTube búsqueda: https://www.youtube.com/results?search_query=${encodeURIComponent(tema + ' educativo español')}
- Google Académico: https://scholar.google.com/scholar?q=${encodeURIComponent(tema)}

Responde JSON:
{"recursos":[{"titulo":"...","fuente":"...","tipo":"Artículo","nivel":"Preparatoria","descripcion":"...","url":"https://...","idioma":"Español","procesable":true,"esVideo":false}],"consejo":"..."}`
            }
        ], true);

        const data = JSON.parse(text);
        const recursos = (data.recursos || []).map(r => ({ ...r, urlActiva: true }));
        data.paraTarea     = recursos.filter(r => r.procesable && !r.esVideo);
        data.materialExtra = recursos.filter(r => !r.procesable || r.esVideo);
        data.recursos      = recursos;
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tutor/explicar-error', rateLimit(20, 60_000), verifyAlumno, async (req, res) => {
    try {
        const pregunta = sanitizeChatInput(req.body.pregunta, 1200);
        const opciones = Array.isArray(req.body.opciones) ? req.body.opciones.map(o => sanitizeChatInput(String(o), 500)) : [];
        const seleccionada = Number.isInteger(req.body.seleccionada) ? req.body.seleccionada : null;
        const correcta = Number.isInteger(req.body.correcta) ? req.body.correcta : 0;
        const explicacionBase = sanitizeChatInput(req.body.explicacion || '', 1200);
        const contexto = sanitizeChatInput(req.body.contexto || '', 2500);
        if (!pregunta || !opciones.length) return res.status(400).json({ error: 'Falta la pregunta u opciones.' });
        const fallback = explicacionBase || explicacionFallback({ p: pregunta, o: opciones, r: correcta });

        try {
            const answer = await iaCall([
                { role: 'system', content: 'Eres un tutor de preparatoria mexicano. Explicas errores de opción múltiple con paciencia, sin burlarte, y ayudas al alumno a entender el concepto. Responde en máximo 4 bullets cortos.' },
                { role: 'user', content: `Pregunta: ${pregunta}
Opciones:
${opciones.map((o,i)=>`${i}. ${o}`).join('\n')}
Respuesta del alumno: ${seleccionada === null ? 'sin responder' : `${seleccionada}. ${opciones[seleccionada] || ''}`}
Respuesta correcta: ${correcta}. ${opciones[correcta] || ''}
Explicación base: ${fallback}
Contexto de clase: ${contexto || 'No disponible'}

Explica por qué se equivocó, por qué la correcta sí responde la pregunta y qué debe repasar.` }
            ], false, { tipo: 'chat', cache: false, alumnoId: req.alumno.id, temperature: 0.35 });
            return res.json({ answer, provider: GEMINI_KEY ? 'gemini' : GROQ_KEY ? 'groq' : 'none' });
        } catch(e) {
            return res.json({ answer: fallback, provider: 'fallback-local', warning: 'IA no disponible; se mostró la explicación base.' });
        }
    } catch(e) { res.status(500).json({ error: e.message }); }
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
                correctas, total, pct, codigo, tareaId, alumnoId } = req.body;
        if (!nombre || !titulo) return res.status(400).json({ error: 'Faltan datos.' });

        let grupoNombre = '';
        if (grupoId) { const g = await Grupo.findById(grupoId); if (g) grupoNombre = g.nombre; }
        let vencimientoInfo = lateInfo(null);
        if (tareaId) {
            const tarea = await Tarea.findById(tareaId).select('fechaVencimiento').lean();
            vencimientoInfo = lateInfo(tarea?.fechaVencimiento);
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
            tareaId: tareaId || null,
            ...vencimientoInfo
        });

        // Verificar logros si hay alumnoId
        let nuevosLogros = [];
        if (alumnoId) {
            try {
                const todasSesiones = await Sesion.find({ nombre }).select('pct creadoEn escuchoPodcast tarjetasAbiertas').lean();
                const totalSes = todasSesiones.length;
                const perfConsec = (() => {
                    let c=0, max=0;
                    for (const s of [...todasSesiones].reverse()) { if((s.pct||0)===100){c++;max=Math.max(max,c);}else c=0; }
                    return max;
                })();
                // Racha actual
                const dias = new Set(todasSesiones.map(s=>new Date(s.creadoEn).toDateString()));
                let racha=0; const hoy=new Date();
                while(dias.has(new Date(hoy.getTime()-racha*86400000).toDateString())) racha++;
                const podcasts = todasSesiones.filter(s=>s.escuchoPodcast).length;
                const totalFC  = todasSesiones.reduce((a,s)=>(a+(s.tarjetasAbiertas?.length||0)),0);

                nuevosLogros = await verificarLogros(alumnoId, {
                    totalSesiones: totalSes, pct, rachaActual: racha,
                    consecutivosPerfectos: perfConsec, hora,
                    podcasts, flashcards: totalFC
                });
            } catch(e) { console.warn('Error verificando logros:', e.message); }
        }

        res.json({ shortId, nuevosLogros, ...vencimientoInfo, retrasoTexto: formatRetraso(vencimientoInfo.retrasoMinutos) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ PDF MÉTRICAS DEV (Brand Collective) ══
app.get('/api/admin/reporte-pdf', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const hace30 = new Date(Date.now()-30*24*60*60*1000);
        const hoy = new Date(new Date().setHours(0,0,0,0));

        const [totalEscuelas, totalMaestros, totalAlumnos, ses30, sesToday] = await Promise.all([
            Escuela.countDocuments(), Maestro.countDocuments(),
            Alumno.countDocuments({activo:true}),
            Sesion.countDocuments({creadoEn:{$gte:hace30}}),
            Sesion.countDocuments({creadoEn:{$gte:hoy}})
        ]);

        const usagePipe = await UsageLog.aggregate([
            {$match:{creadoEn:{$gte:hace30}}},
            {$group:{_id:null, tokens:{$sum:'$tokensTotal'}, costo:{$sum:'$costoUSD'}, llamadas:{$sum:1}}}
        ]);
        const uso = usagePipe[0]||{tokens:0,costo:0,llamadas:0};

        const escuelas = await Escuela.find({}).select('nombre ciudad').lean();
        const fechaHoy = new Date().toLocaleDateString('es-MX',{year:'numeric',month:'long',day:'numeric'});

        const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Reporte Brand Collective — Tutor IA</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1a2235;background:white;padding:40px}
  .header{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:white;border-radius:16px;padding:28px 32px;margin-bottom:28px}
  .header h1{font-size:1.3rem;font-weight:800;margin-bottom:4px}
  .header p{font-size:.82rem;opacity:.75}
  .kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}
  .kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;text-align:center}
  .kpi-val{font-size:1.8rem;font-weight:800;margin-bottom:4px}
  .kpi-label{font-size:.72rem;color:#718096;text-transform:uppercase;letter-spacing:.06em}
  .section{margin-bottom:24px}
  .section h2{font-size:.85rem;font-weight:700;color:#4f46e5;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
  .escuela-row{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#f8fafc;border-radius:8px;margin-bottom:6px;font-size:.85rem}
  .footer{text-align:center;margin-top:32px;font-size:.72rem;color:#a0aec0;border-top:1px solid #e2e8f0;padding-top:16px}
  @media print{body{padding:20px}@page{margin:1cm}}
</style></head><body>
<div class="header">
  <h1>📊 Reporte de Plataforma — Tutor IA</h1>
  <p>Brand Collective · Generado el ${fechaHoy}</p>
</div>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-val" style="color:#7c3aed">${totalEscuelas}</div><div class="kpi-label">Escuelas</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#4f46e5">${totalMaestros}</div><div class="kpi-label">Maestros</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#059669">${totalAlumnos}</div><div class="kpi-label">Alumnos activos</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#059669">${sesToday}</div><div class="kpi-label">Sesiones hoy</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#7c3aed">${ses30}</div><div class="kpi-label">Sesiones 30d</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#d97706">$${uso.costo.toFixed(3)}</div><div class="kpi-label">Costo IA 30d (USD)</div></div>
</div>
<div class="section">
  <h2>Uso de IA (30 días)</h2>
  <div class="escuela-row"><span>Tokens consumidos</span><strong>${(uso.tokens/1000).toFixed(1)}K</strong></div>
  <div class="escuela-row"><span>Llamadas a IA</span><strong>${uso.llamadas}</strong></div>
  <div class="escuela-row"><span>Costo total estimado</span><strong>$${uso.costo.toFixed(4)} USD</strong></div>
  <div class="escuela-row"><span>Costo por sesión</span><strong>$${ses30>0?(uso.costo/ses30).toFixed(5):0} USD</strong></div>
</div>
<div class="section">
  <h2>Escuelas registradas</h2>
  ${escuelas.map((e,i)=>`<div class="escuela-row"><span>${i+1}. ${e.nombre}</span><span style="color:#718096">${e.ciudad||'—'}</span></div>`).join('')||'<p style="color:#718096;font-size:.85rem">Sin escuelas registradas</p>'}
</div>
<div class="footer">Tutor IA · Brand Collective · brandcollectivemx.com — ${fechaHoy}</div>
</body></html>`;

        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.send(html);
    } catch(e) { res.status(500).json({ error: e.message }); }
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

        // Buscar invitación (puede existir pero estar usada o vencida)
        const inv = await Invitacion.findOne({ codigo: codigoInvitacion });
        if (!inv) return res.status(403).json({ error: 'Código de invitación inválido. Pide uno nuevo al admin.', code: 'INV_NOT_FOUND' });
        if (inv.usada) return res.status(403).json({ error: 'Este código ya fue usado para crear una cuenta. Pide al admin que lo renueve o usa el login.', code: 'INV_USED' });
        if (inv.fechaVencimiento && inv.fechaVencimiento < new Date())
            return res.status(403).json({ error: 'La invitación venció. Pide al admin que la renueve.', code: 'INV_EXPIRED' });

        // Verificar que el email no tenga ya cuenta
        const existe = await Maestro.findOne({ email: inv.email });
        if (existe) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Usa el login en lugar de registro.', code: 'EMAIL_TAKEN' });

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
app.post('/api/maestro/login', rateLimit(20, 60_000), async (req, res) => {
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
        const { input, grupoId, fechaVencimiento } = req.body;
        if (!input) return res.status(400).json({ error: 'Falta contenido.' });

        // Resolver texto si es URL (retorna string o {texto, videoId, esVideo} para YouTube)
        let fuente = input.trim();
        if (fuente.startsWith('http')) fuente = await extraerTextoWeb(fuente);
        const texto = typeof fuente === 'object' ? fuente.texto : fuente;

        // Cargar grupo para obtener materia/semestre que especializarán el prompt
        let grupoCtx = null;
        if (grupoId && mongoose.connection.readyState) {
            grupoCtx = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id })
                .select('materia semestre').lean();
        }

        // Generar clase + pool de 15 preguntas
        const meta = {
            maestroId: req.maestro.id,
            tipo: 'tarea',
            materia: grupoCtx?.materia,
            semestre: grupoCtx?.semestre
        };
        const generated = await procesarConIAPool(texto, meta);

        const shortId = await shortIdUnico(Tarea);
        const tarea = await Tarea.create({
            shortId,
            maestroId: req.maestro.id,
            grupoId:   grupoId || null,
            titulo:    generated.titulo,
            abstract:  generated.abstract || '',
            resumen:   generated.resumen,
            podcast:   generated.podcast || '',
            glosario:  generated.glosario || [],
            ejemplosPracticos: generated.ejemplosPracticos || [],
            rubrica:   generated.rubrica || [],
            flashcards: generated.flashcards || [],
            poolPreguntas: normalizeQuestions(generated.poolPreguntas || generated.quiz || []),
            contexto:  texto.substring(0, 10000),
            fechaVencimiento: parseOptionalDate(fechaVencimiento),
            origen: input.trim().startsWith('http') ? 'link' : 'texto'
        });

        res.json({ shortId: tarea.shortId, titulo: tarea.titulo, abstract: tarea.abstract });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar tareas del maestro (con conteo de sesiones por tarea)
app.get('/api/maestro/tareas', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const tareas = await Tarea.find({ maestroId: req.maestro.id })
            .select('shortId titulo abstract grupoId vistas creadoEn fechaVencimiento origen')
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
        const pool = normalizeQuestions(tarea.poolPreguntas || []);
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
            tareaId:    tarea._id,
            fechaVencimiento: tarea.fechaVencimiento,
            entregaTarde: lateInfo(tarea.fechaVencimiento).entregaTarde,
            retrasoMinutos: lateInfo(tarea.fechaVencimiento).retrasoMinutos,
            esTarea:    true   // flag para que el frontend sepa el origen
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear tarea desde archivos (fotos/PDF) — igual que tarea texto pero con upload
// ══ EXTRACCIÓN DE IMAGEN CENTRALIZADA — Gemini Vision + GROQ fallback ══
const PROMPT_VISION = `Eres un asistente educativo experto en transcripción fiel y estructurada de material de estudio (apuntes, libros, pizarrones, láminas, ejercicios, mapas conceptuales, exámenes, diagramas).

EXTRAE con precisión ABSOLUTA y organiza en secciones claras:
1. TÍTULO principal del material (si aparece).
2. DEFINICIONES: transcribe literal cada definición encontrada.
3. EJEMPLOS / EJERCICIOS con enunciado y — si aparece — solución paso a paso.
4. FÓRMULAS: reescríbelas en formato texto claro. Ej: "E = mc²", "pH = -log[H+]", "x = (-b ± √(b² - 4ac)) / 2a".
5. TABLAS: transcríbelas fila por fila separando columnas con " | ".
6. DIAGRAMAS / ESQUEMAS: descríbelos en palabras indicando qué representa cada elemento y las relaciones.
7. DATOS CLAVE: fechas, nombres propios, unidades, magnitudes, constantes.
8. TEXTO PLANO: todo lo demás del material que sea educativo.

IGNORA completamente menús, botones, iconos de navegación, cursores, publicidad, banners, marcas de agua, logotipos aislados, pies de página del sitio web, URLs de navegación, fechas de acceso, ruido fotográfico (dedos, sombras, bordes).

FORMATO DE SALIDA (texto plano con encabezados en MAYÚSCULAS — así el siguiente procesador identifica las secciones):

TÍTULO: ...
DEFINICIONES:
- ...
EJEMPLOS:
- Enunciado: ...
  Solución: ...
FÓRMULAS:
- ...
TABLAS:
- Col1 | Col2 | Col3
  v11 | v12 | v13
DIAGRAMAS:
- ...
DATOS CLAVE:
- ...
TEXTO PLANO:
<todo lo demás>

REGLAS:
• Si el material está en otro idioma, transcribe en el idioma original sin traducir.
• Si partes son ilegibles, escribe "[ilegible]" y continúa.
• No inventes contenido que no está en la imagen.
• Responde SOLO con el contenido extraído siguiendo el formato, sin introducciones ni comentarios.`;

async function extractImageText(buf, mime) {
    // Intentar Gemini 2.0 Flash Vision primero (mejor calidad)
    if (GEMINI_KEY) {
        try {
            const body = {
                contents: [{ role: 'user', parts: [
                    { inlineData: { mimeType: mime, data: buf.toString('base64') } },
                    { text: PROMPT_VISION }
                ]}],
                generationConfig: { temperature: 0.05, maxOutputTokens: 6144 }
            };
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                body, { headers: { 'Content-Type': 'application/json' }, timeout: 45000 }
            );
            const text = res.data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
            if (text.trim().length > 20) return text;
        } catch(e) { console.warn('Gemini Vision falló:', e.message); }
    }
    // Fallback: GROQ llama-4-scout (multimodal)
    if (GROQ_KEY) {
        const res = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { model: 'meta-llama/llama-4-scout-17b-16e-instruct',
              messages: [{ role: 'user', content: [
                { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
                { type: 'text', text: PROMPT_VISION }
              ]}], max_tokens: 4096 },
            { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        return res.data.choices[0].message.content || '';
    }
    throw new Error('No hay motor de visión disponible. Configura GEMINI_API_KEY o GROQ_API_KEY.');
}

app.post('/api/maestro/tarea-archivo', verifyToken, upload.array('archivos', 10), async (req, res) => {
    const archivos = req.files || [];
    const tmpPaths = archivos.map(f => f.path);
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        if (!archivos.length) return res.status(400).json({ error: 'No se recibieron archivos.' });

        const { grupoId, fechaVencimiento } = req.body;
        let textoTotal = '';

        for (const archivo of archivos) {
            const buf = await readFile(archivo.path);
            const mime = archivo.mimetype;
            let texto = '';
            if (mime === 'application/pdf') {
                try { texto = (await pdfParse(buf)).text; } catch { texto = ''; }
            } else if (mime.startsWith('image/')) {
                texto = await extractImageText(buf, mime);
            } else {
                texto = buf.toString('utf-8');
            }
            if (texto.trim()) textoTotal += texto + '\n\n';
        }

        if (!textoTotal.trim() || textoTotal.trim().length < 30)
            throw new Error('No se encontró suficiente texto en los archivos.');

        let grupoCtx = null;
        if (grupoId && mongoose.connection.readyState) {
            grupoCtx = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id })
                .select('materia semestre').lean();
        }
        const meta = {
            maestroId: req.maestro.id,
            tipo: 'tarea',
            materia: grupoCtx?.materia,
            semestre: grupoCtx?.semestre
        };
        const generated = await procesarConIAPool(textoTotal, meta);
        const shortId = await shortIdUnico(Tarea);
        const tarea = await Tarea.create({
            shortId, maestroId: req.maestro.id, grupoId: grupoId || null,
            titulo:    generated.titulo,
            abstract:  generated.abstract || '',
            resumen:   generated.resumen,
            podcast:   generated.podcast || '',
            glosario:  generated.glosario || [],
            ejemplosPracticos: generated.ejemplosPracticos || [],
            rubrica:   generated.rubrica || [],
            flashcards: generated.flashcards || [],
            poolPreguntas: normalizeQuestions(generated.poolPreguntas || generated.quiz || []),
            contexto:  textoTotal.substring(0, 10000),
            fechaVencimiento: parseOptionalDate(fechaVencimiento),
            origen: 'archivo',
            archivoResumen: textoTotal.substring(0, 1200)
        });
        res.json({ shortId: tarea.shortId, titulo: tarea.titulo, abstract: tarea.abstract });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { for (const p of tmpPaths) await unlink(p).catch(() => {}); }
});

app.post('/api/maestro/tarea/:shortId/laboratorio-ia', rateLimit(20, 60_000), verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const tarea = await Tarea.findOne({ shortId: req.params.shortId, maestroId: req.maestro.id });
        if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });

        const modo = String(req.body.modo || 'pulir_pool');
        const instruccion = sanitizeChatInput(req.body.instruccion || '', 1800);
        const preguntaIndex = Number.isInteger(req.body.preguntaIndex) ? req.body.preguntaIndex : null;
        const aplicarCambios = !!req.body.aplicarCambios;
        const modos = {
            corregir_apuntes: 'corrige y mejora claridad de apuntes/resumen sin cambiar el sentido',
            pulir_pool: 'mejora la calidad del pool de preguntas, distractores y explicaciones',
            generar_variantes: 'genera variantes equivalentes de preguntas sin repetir conceptos',
            mejorar_explicaciones: 'mejora explicaciones de respuesta correcta y errores comunes',
            revisar_bloom: 'revisa dificultad, Bloom y progresion pedagogica'
        };
        if (!modos[modo]) return res.status(400).json({ error: 'Modo de laboratorio no soportado.' });

        const poolBase = normalizeQuestions(tarea.poolPreguntas || []);
        const objetivo = preguntaIndex !== null ? [poolBase[preguntaIndex]].filter(Boolean) : poolBase;
        const messages = [
            { role: 'system', content: 'Eres un co-diseñador pedagógico para maestros de preparatoria mexicana. Responde solo JSON válido. Nunca inventes contenido fuera del material base.' },
            { role: 'user', content: `Modo: ${modo} (${modos[modo]})
Instrucción del maestro: ${instruccion || 'Mejora calidad, claridad y precisión.'}

Tarea: ${tarea.titulo}
Resumen actual:
${String(tarea.resumen || '').replace(/<[^>]+>/g,' ').substring(0, 5000)}

Preguntas objetivo:
${JSON.stringify(objetivo.length ? objetivo : poolBase.slice(0, 15)).substring(0, 12000)}

Devuelve JSON:
{
  "resumenSugerido": "texto opcional si aplica",
  "poolSugerido": [{"p":"...","o":["A","B","C","D"],"r":0,"bloom":"recordar","explicacion":"..."}],
  "notas": ["cambio 1","cambio 2"]
}

Si el modo no requiere cambiar resumen, deja resumenSugerido vacío. Si no requiere cambiar pool, deja poolSugerido como [].` }
        ];
        const raw = await iaCall(messages, true, { tipo: 'tarea', maestroId: req.maestro.id, cache: false, temperature: 0.35 });
        const clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        const preview = JSON.parse(clean.match(/\{[\s\S]+\}/)?.[0] || clean);
        const poolSugerido = normalizeQuestions(preview.poolSugerido || []);
        const resumenSugerido = String(preview.resumenSugerido || '').trim();

        if (aplicarCambios) {
            const update = {};
            if (resumenSugerido) update.resumen = resumenSugerido;
            if (poolSugerido.length) {
                if (preguntaIndex !== null && poolBase[preguntaIndex]) {
                    const nuevoPool = [...poolBase];
                    nuevoPool[preguntaIndex] = poolSugerido[0];
                    update.poolPreguntas = nuevoPool;
                } else {
                    update.poolPreguntas = poolSugerido;
                }
            }
            if (!Object.keys(update).length) return res.json({ ok: true, aplicado: false, preview: { ...preview, poolSugerido } });
            await Tarea.updateOne({ _id: tarea._id }, { $set: update });
            return res.json({ ok: true, aplicado: true, preview: { ...preview, poolSugerido } });
        }

        res.json({ ok: true, aplicado: false, preview: { ...preview, poolSugerido } });
    } catch(e) { res.status(500).json({ error: e.message || 'No se pudo procesar el laboratorio IA.' }); }
});
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
    const okEmail = safeEqual(email.toLowerCase(), adminEmail.toLowerCase());
    const okPwd   = safeEqual(pwd, adminPwd);
    if (!okEmail || !okPwd) return res.status(401).json({ error: 'Credenciales incorrectas.' });
    next();
}

function safeAiError(e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message || 'Error desconocido';
    return `${status ? `HTTP ${status}: ` : ''}${String(msg).replace(/AIza[\w-]+|gsk_[\w-]+/g, '[redacted]').substring(0, 240)}`;
}

app.post('/api/admin/diagnostico-ia', rateLimit(10, 60_000), verifyAdmin, async (req, res) => {
    const prompt = [
        { role: 'system', content: 'Responde breve en español mexicano.' },
        { role: 'user', content: `Di OK Tutor IA ${APP_VERSION} y menciona una recomendación educativa en una frase.` }
    ];
    const probar = async (nombre, fn, configurado, modelo) => {
        if (!configurado) return { proveedor: nombre, configurado: false, ok: false, modelo: null, error: 'Variable no configurada.' };
        const inicio = Date.now();
        try {
            const texto = await fn(prompt, false, { tipo: 'chat', cache: false, temperature: 0.1 });
            return { proveedor: nombre, configurado: true, ok: true, modelo, ms: Date.now() - inicio, muestra: texto.substring(0, 180) };
        } catch(e) {
            return { proveedor: nombre, configurado: true, ok: false, modelo, ms: Date.now() - inicio, error: safeAiError(e) };
        }
    };
    const [gemini, groq] = await Promise.all([
        probar('gemini', geminiCall, !!GEMINI_KEY, GEMINI_MODEL),
        probar('groq', groqCall, !!GROQ_KEY, GROQ_MODEL)
    ]);
    res.json({
        ok: gemini.ok || groq.ok,
        version: APP_VERSION,
        estrategia: 'Gemini principal; Groq backup.',
        primary: GEMINI_KEY ? 'gemini' : GROQ_KEY ? 'groq' : 'none',
        fallback: GROQ_KEY ? 'groq' : null,
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        gemini,
        groq
    });
});

// ══ CHAT IA ADMIN — asistente de operaciones con contexto agregado global ══
app.post('/api/admin/chat', rateLimit(40, 60_000), verifyAdmin, async (req, res) => {
    try {
        const { pregunta: rawPreg, historial } = req.body;
        const pregunta = sanitizeChatInput(rawPreg);
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });
        const guard = chatGuardrail('admin', pregunta, true);
        if (!guard.ok) return res.json({ answer: guard.answer, guardrail: true });

        let ctx = 'Base de datos no disponible.';
        if (mongoose.connection.readyState) {
            const hace30 = new Date(Date.now() - 30*24*60*60*1000);
            const hace7  = new Date(Date.now() - 7*24*60*60*1000);
            const hoy    = new Date(new Date().setHours(0,0,0,0));

            const [totalEscuelas, totalDirectores, totalMaestros, totalAlumnos, totalGrupos,
                   totalTareas, ses30, ses7, sesToday, invitacionesAbiertas] = await Promise.all([
                Escuela.countDocuments(),
                Director.countDocuments(),
                Maestro.countDocuments(),
                Alumno.countDocuments({ activo: true }),
                Grupo.countDocuments(),
                Tarea.countDocuments(),
                Sesion.countDocuments({ creadoEn: { $gte: hace30 } }),
                Sesion.countDocuments({ creadoEn: { $gte: hace7 } }),
                Sesion.countDocuments({ creadoEn: { $gte: hoy } }),
                Invitacion.countDocuments({ usada: false })
            ]);

            const muestra = await Sesion.find({ creadoEn: { $gte: hace30 } }).select('pct grupoId').lean().limit(600);
            const promGlobal = muestra.length ? Math.round(muestra.reduce((a,s)=>a+(s.pct||0),0)/muestra.length) : 0;

            // Uso por escuela
            const escuelas = await Escuela.find().select('nombre').lean();
            const usoEscuelas = await Promise.all(escuelas.map(async e => {
                const maestros = await Maestro.find({ escuelaId: e._id }).select('_id').lean();
                const grupos   = await Grupo.find({ maestroId: { $in: maestros.map(m=>m._id) } }).select('_id').lean();
                const cnt7     = await Sesion.countDocuments({ grupoId: { $in: grupos.map(g=>g._id) }, creadoEn: { $gte: hace7 } });
                return { nombre: e.nombre, sesiones7d: cnt7, maestros: maestros.length, grupos: grupos.length };
            }));
            usoEscuelas.sort((a,b) => b.sesiones7d - a.sesiones7d);

            // Maestros inactivos 14 días
            const hace14 = new Date(Date.now() - 14*24*60*60*1000);
            const maestrosDoc = await Maestro.find().select('nombre email escuelaId').lean();
            const inactivos = [];
            for (const m of maestrosDoc) {
                const gids = (await Grupo.find({ maestroId: m._id }).select('_id').lean()).map(g=>g._id);
                if (!gids.length) continue;
                const ult = await Sesion.findOne({ grupoId: { $in: gids } }).sort({ creadoEn: -1 }).select('creadoEn').lean();
                if (!ult || new Date(ult.creadoEn) < hace14) inactivos.push(m.nombre);
            }

            // Gasto estimado últimos 30 días
            const costAgg = await UsageLog.aggregate([
                { $match: { creadoEn: { $gte: hace30 } } },
                { $group: { _id: null, total: { $sum: '$costoUSD' }, tokens: { $sum: '$tokensTotal' } } }
            ]).catch(() => []);
            const costo30 = costAgg[0]?.total || 0;
            const tokens30 = costAgg[0]?.tokens || 0;

            ctx = `SISTEMA TUTOR IA — Vista admin global
• Escuelas: ${totalEscuelas} | Directores: ${totalDirectores} | Maestros: ${totalMaestros} | Alumnos: ${totalAlumnos}
• Grupos: ${totalGrupos} | Tareas creadas: ${totalTareas} | Invitaciones pendientes: ${invitacionesAbiertas}
• Sesiones: hoy=${sesToday}, 7d=${ses7}, 30d=${ses30}
• Promedio global: ${promGlobal}%
• Gasto IA 30d (estimado): $${costo30.toFixed(4)} USD | ${tokens30.toLocaleString()} tokens
• Top 5 escuelas por uso 7d:
${usoEscuelas.slice(0,5).map(e=>`  - ${e.nombre}: ${e.sesiones7d} sesiones (${e.maestros} maestros, ${e.grupos} grupos)`).join('\n') || '  (ninguna)'}
• Maestros inactivos ≥14d: ${inactivos.length} → ${inactivos.slice(0,10).join(', ') || 'ninguno'}`;
        }

        const histMsgs = (historial || []).slice(-8).map(m => ({
            role: m.role === 'admin' ? 'user' : 'assistant',
            content: sanitizeChatInput(m.texto, 2000)
        }));

        const messages = [
            { role: 'system', content: `Eres el asistente de operaciones del admin del sistema Tutor IA (Brand Collective MX). Tu rol es ayudar a analizar uso del sistema, detectar maestros inactivos, sugerir acciones de retención/activación, ayudar con flujos operativos (alta de escuelas, CSV de alumnos, invitaciones de maestros, reset de contraseñas, límites diarios) y responder preguntas sobre costos y salud del sistema.

REGLAS:
• Usa ÚNICAMENTE los datos del contexto. NUNCA inventes métricas ni nombres.
• Si falta información, dilo y sugiere qué consultar.
• Respuestas ejecutivas: máximo 4 puntos o 2-3 párrafos cortos.
• Propón acciones concretas con nombres reales cuando los tengas.
• Español mexicano, tono profesional pero directo.

CONTEXTO DEL SISTEMA:
${ctx}` },
            ...histMsgs,
            { role: 'user', content: pregunta }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat', cache: false });
        res.json({ answer });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

function generarPasswordTemporal() {
    return crypto.randomBytes(9).toString('base64url').substring(0, 12) + '!';
}

async function enviarEmailPasswordTemporal(destinatario, nombre, passwordTemporal, rol) {
    if (!process.env.RESEND_API_KEY) return false;
    const rolLabel = rol === 'maestro' ? 'maestro' : rol === 'director' ? 'director' : 'alumno';
    const html = `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px">
          <h2 style="color:#7c3aed">Contraseña restablecida - Tutor IA</h2>
          <p>Hola ${nombre}, el administrador del sistema restableció tu contraseña de ${rolLabel}.</p>
          <p>Tu nueva contraseña temporal es:</p>
          <p style="font-family:monospace;font-size:20px;background:#f5f3ff;padding:14px;border-radius:8px;text-align:center">${passwordTemporal}</p>
          <p>Te recomendamos cambiarla después de iniciar sesión.</p>
          <p style="color:#6b7280;font-size:13px">Si no reconoces este cambio, contacta a soporte.</p>
        </div>`;
    await axios.post('https://api.resend.com/emails', {
        from: 'Tutor IA <no-reply@brandcollectivemx.com>',
        to: [destinatario],
        subject: 'Contraseña restablecida - Tutor IA',
        html
    }, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    return true;
}

async function resetPasswordAdmin(Modelo, id, rol, passwordExplicita = null) {
    const usuario = await Modelo.findById(id);
    if (!usuario) return null;

    // Si el admin proporcionó una contraseña explícita, úsala. Si no, autogenera.
    const nueva = (passwordExplicita && passwordExplicita.length >= 6)
        ? passwordExplicita
        : generarPasswordTemporal();
    usuario.passwordHash = await bcrypt.hash(nueva, 10);
    if ('resetToken' in usuario)    usuario.resetToken = null;
    if ('resetTokenExp' in usuario) usuario.resetTokenExp = null;
    await usuario.save();

    let emailEnviado = false;
    // Solo enviar email automático si no fue contraseña explícita
    if (!passwordExplicita) {
        try {
            emailEnviado = await enviarEmailPasswordTemporal(usuario.email, usuario.nombre, nueva, rol);
        } catch(e) {
            console.warn(`Email reset ${rol} admin falló:`, e.message);
        }
    }

    return {
        ok: true,
        emailEnviado,
        // Si fue explícita, no la devolvemos (el admin ya la sabe)
        passwordTemporal: passwordExplicita ? null : (emailEnviado ? null : nueva),
        email: usuario.email,
        nombre: usuario.nombre
    };
}

// ══ RESET PASSWORD POR ADMIN ══
app.post('/api/admin/maestro/:maestroId/reset-password', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { password } = req.body || {};
        const result = await resetPasswordAdmin(Maestro, req.params.maestroId, 'maestro', password);
        if (!result) return res.status(404).json({ error: 'Maestro no encontrado.' });
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/alumno/:alumnoId/reset-password', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { password } = req.body || {};
        const result = await resetPasswordAdmin(Alumno, req.params.alumnoId, 'alumno', password);
        if (!result) return res.status(404).json({ error: 'Alumno no encontrado.' });
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/director/:directorId/reset-password', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { password } = req.body || {};
        const result = await resetPasswordAdmin(Director, req.params.directorId, 'director', password);
        if (!result) return res.status(404).json({ error: 'Director no encontrado.' });
        res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// Listar todos los maestros con grupos y actividad
app.get('/api/admin/maestros', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const maestros = await Maestro.find().select('-passwordHash').sort({ creadoEn: -1 });
        const invitaciones = await Invitacion.find({ usada: false });

        // Enriquecer cada maestro con sus grupos y stats
        const hace7dias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const maestrosEnriquecidos = await Promise.all(maestros.map(async m => {
            const grupos = await Grupo.find({ maestroId: m._id }).select('_id shortId nombre semestre materia').lean();
            const grupoIds = grupos.map(g => g._id);

            const [totalTareas, totalSesiones, sesionesRecientes] = await Promise.all([
                Tarea.countDocuments({ maestroId: m._id }),
                Sesion.countDocuments({ grupoId: { $in: grupoIds } }),
                Sesion.countDocuments({ grupoId: { $in: grupoIds }, creadoEn: { $gte: hace7dias } })
            ]);

            // Promedio del maestro
            const sesionesConPct = await Sesion.find({ grupoId: { $in: grupoIds } }).select('pct').lean();
            const promedio = sesionesConPct.length
                ? Math.round(sesionesConPct.reduce((a, s) => a + (s.pct || 0), 0) / sesionesConPct.length)
                : null;

            // Última actividad
            const ultimaSesion = await Sesion.findOne({ grupoId: { $in: grupoIds } })
                .sort({ creadoEn: -1 }).select('creadoEn').lean();
            const ultimaTarea = await Tarea.findOne({ maestroId: m._id })
                .sort({ creadoEn: -1 }).select('creadoEn').lean();
            const ultimaActividad = [ultimaSesion?.creadoEn, ultimaTarea?.creadoEn]
                .filter(Boolean).sort((a, b) => b - a)[0] || null;

            return {
                _id: m._id, nombre: m.nombre, email: m.email, creadoEn: m.creadoEn,
                grupos, totalTareas, totalSesiones, sesionesRecientes,
                promedio, ultimaActividad
            };
        }));

        res.json({ maestros: maestrosEnriquecidos, invitaciones });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Crear invitación para un maestro (genera código + crea grupos automáticamente al usarse)
// Agregar grupo a un maestro existente
app.post('/api/admin/maestro/:maestroId/grupo', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { maestroId } = req.params;
        const { semestre, materia } = req.body;
        if (!semestre || !materia) return res.status(400).json({ error: 'Faltan semestre y materia.' });
        const maestro = await Maestro.findById(maestroId);
        if (!maestro) return res.status(404).json({ error: 'Maestro no encontrado.' });
        // Verificar que no tenga ya ese grupo
        const existe = await Grupo.findOne({ maestroId, semestre, materia });
        if (existe) return res.status(400).json({ error: 'El maestro ya tiene ese grupo.' });
        const shortId = await shortIdUnico(Grupo);
        const grupo = await Grupo.create({
            shortId, nombre: `${materia} — ${semestre}`,
            semestre, materia, maestroId
        });
        res.json({ grupo });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Quitar grupo de un maestro
app.delete('/api/admin/maestro/:maestroId/grupo/:grupoId', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { maestroId, grupoId } = req.params;
        const grupo = await Grupo.findOne({ _id: grupoId, maestroId });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado para este maestro.' });
        // Borrar el grupo y sus tareas (sesiones se conservan por historial)
        await Promise.all([
            Grupo.deleteOne({ _id: grupoId }),
            Tarea.deleteMany({ grupoId })
        ]);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

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
        res.json({ codigo: inv.codigo, nombre: inv.nombre, email: inv.email, grupos: inv.grupos, fechaVencimiento: inv.fechaVencimiento });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Renovar / regenerar invitación: extiende fechaVencimiento 7 días y, si estaba usada, genera nuevo código
app.post('/api/admin/invitacion/:id/renovar', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const inv = await Invitacion.findById(req.params.id);
        if (!inv) return res.status(404).json({ error: 'Invitación no encontrada.' });

        // Si estaba usada, generamos un código nuevo y permitimos un re-registro
        // (esto es útil cuando el maestro perdió su contraseña o nunca completó el flujo).
        if (inv.usada) {
            // Asegurar que ya no exista una cuenta atada a ese email
            const existe = await Maestro.findOne({ email: (inv.email || '').toLowerCase() });
            if (existe) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Usa "Resetear contraseña" del maestro en su lugar.', code: 'EMAIL_TAKEN' });

            let codigo = generarCodigoInvitacion(inv.nombre || 'maestro');
            while (await Invitacion.findOne({ codigo })) {
                codigo = generarCodigoInvitacion(inv.nombre || 'maestro');
            }
            inv.codigo = codigo;
            inv.usada = false;
            inv.maestroId = null;
        }
        inv.fechaVencimiento = new Date(Date.now() + INVITACION_TTL_MS);
        await inv.save();
        res.json({ codigo: inv.codigo, fechaVencimiento: inv.fechaVencimiento, usada: inv.usada });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Borrar invitación (forzado: incluso si está usada, útil para limpieza)
app.delete('/api/admin/invitacion/:codigo', verifyAdmin, async (req, res) => {
    try {
        await Invitacion.deleteOne({ codigo: req.params.codigo });
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

// ══ LÍMITE DIARIO — ajustar por alumno o por grupo ══
app.patch('/api/admin/alumno/:alumnoId/limite', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { limiteDiario } = req.body;
        if (!limiteDiario || limiteDiario < 1) return res.status(400).json({ error: 'Límite inválido.' });
        const alumno = await Alumno.findByIdAndUpdate(
            req.params.alumnoId,
            { limiteDiario: parseInt(limiteDiario) },
            { new: true }
        ).select('-passwordHash');
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });
        res.json({ alumno });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ajustar límite a todo un grupo
app.patch('/api/admin/grupo/:grupoId/limite', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { limiteDiario } = req.body;
        if (!limiteDiario || limiteDiario < 1) return res.status(400).json({ error: 'Límite inválido.' });
        const result = await Alumno.updateMany(
            { grupoId: req.params.grupoId },
            { limiteDiario: parseInt(limiteDiario) }
        );
        res.json({ actualizados: result.modifiedCount });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Consultar sesiones restantes del día (el alumno puede ver cuántas le quedan)
app.get('/api/alumno/limite', verifyAlumno, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const hoy = new Date().toISOString().split('T')[0];
        const alumno = await Alumno.findById(req.alumno.id).select('sesionesHoy limiteDiario ultimaFechaSesion');
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });
        const sesionesHoy = alumno.ultimaFechaSesion === hoy ? (alumno.sesionesHoy || 0) : 0;
        const limite = alumno.limiteDiario || 10;
        res.json({ sesionesHoy, limite, restantes: Math.max(0, limite - sesionesHoy) });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ DETECCIÓN DE PLAGIO ══
// Detectar si dos alumnos del mismo grupo entregaron el mismo tema en las últimas 2 horas
app.get('/api/maestro/plagio/:grupoId', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupo = await Grupo.findOne({ _id: req.params.grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const sesiones = await Sesion.find({
            grupoId: grupo._id,
            creadoEn: { $gte: hace2h }
        }).select('nombre titulo tareaId codigo creadoEn').lean();

        // Agrupar por tareaId o por titulo similar
        const grupos = {};
        sesiones.forEach(s => {
            const key = s.tareaId?.toString() || s.titulo?.toLowerCase().trim().substring(0, 50);
            if (!grupos[key]) grupos[key] = [];
            grupos[key].push(s);
        });

        // Solo casos con más de un alumno en el mismo tema
        const sospechas = Object.entries(grupos)
            .filter(([_, ss]) => ss.length > 1)
            .map(([key, ss]) => ({
                tema: ss[0].titulo,
                alumnos: ss.map(s => ({ nombre: s.nombre, hora: s.hora || '', codigo: s.codigo })),
                totalAlumnos: ss.length
            }));

        res.json({ sospechas, revisadas: sesiones.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ REPORTE MENSUAL DE ALUMNO ══
app.get('/api/maestro/reporte/:grupoId/:nombre', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupo = await Grupo.findOne({ _id: req.params.grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const nombre = decodeURIComponent(req.params.nombre);
        const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const sesiones = await Sesion.find({
            grupoId: grupo._id,
            nombre: { $regex: new RegExp(nombre, 'i') },
            creadoEn: { $gte: hace30 }
        }).sort({ creadoEn: 1 }).select('-chatMensajes -tarjetasAbiertas').lean();

        if (!sesiones.length) return res.status(404).json({ error: 'Sin sesiones en los últimos 30 días.' });

        const promedio = Math.round(sesiones.reduce((a, s) => a + (s.pct || 0), 0) / sesiones.length);
        const mejor = sesiones.reduce((a, s) => s.pct > a.pct ? s : a, sesiones[0]);
        const peor  = sesiones.reduce((a, s) => s.pct < a.pct ? s : a, sesiones[0]);

        // Tendencia: comparar primera mitad vs segunda mitad
        const mid = Math.floor(sesiones.length / 2);
        const promedioInicio = sesiones.slice(0, mid).reduce((a,s)=>a+(s.pct||0),0) / (mid||1);
        const promedioFin    = sesiones.slice(mid).reduce((a,s)=>a+(s.pct||0),0) / (sesiones.length - mid || 1);
        const tendencia = promedioFin > promedioInicio + 5 ? 'mejorando' : promedioFin < promedioInicio - 5 ? 'bajando' : 'estable';

        // Temas fallados frecuentemente
        const fallos = {};
        sesiones.forEach(s => {
            (s.respuestasQuiz || []).filter(r => !r.esCorrecta).forEach(r => {
                const t = r.pregunta?.substring(0, 40) || 'sin datos';
                fallos[t] = (fallos[t] || 0) + 1;
            });
        });
        const topFallos = Object.entries(fallos).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([t,n])=>({tema:t,veces:n}));

        res.json({
            nombre, grupo: grupo.nombre, periodo: '30 días',
            totalSesiones: sesiones.length,
            promedio, mejor: { titulo: mejor.titulo, pct: mejor.pct },
            peor:  { titulo: peor.titulo,  pct: peor.pct },
            tendencia, topFallos,
            sesiones: sesiones.map(s => ({
                fecha: s.fecha, titulo: s.titulo, pct: s.pct,
                correctas: s.correctas, total: s.total
            }))
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ PUSH NOTIFICATIONS ══

// Guardar suscripción push del maestro
app.post('/api/maestro/push-subscribe', verifyToken, async (req, res) => {
    try {
        const { subscription } = req.body;
        if (!subscription?.endpoint) return res.status(400).json({ error: 'Suscripción inválida.' });
        await PushSub.findOneAndUpdate(
            { maestroId: req.maestro.id },
            { maestroId: req.maestro.id, subscription },
            { upsert: true, new: true }
        );
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enviar notificación push a maestro (llamado internamente al entregar sesión)
async function notificarMaestro(grupoId, mensaje) {
    try {
        const grupo = await Grupo.findById(grupoId).lean();
        if (!grupo) return;
        const sub = await PushSub.findOne({ maestroId: grupo.maestroId }).lean();
        if (!sub?.subscription?.endpoint) return;
        // Notificación básica via fetch al endpoint de push
        const payload = JSON.stringify({
            title: 'Tutor IA — Nueva entrega',
            body: mensaje,
            tag: 'entrega-' + Date.now(),
            url: './'
        });
        // Enviar directo al endpoint sin VAPID (compatible sin librería)
        await fetch(sub.subscription.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'TTL': '86400' },
            body: payload
        }).catch(() => {}); // silenciar errores si push falla
    } catch(e) {}
}

// ══ EXAMEN FINAL ══

// Crear examen combinando preguntas de varias tareas
app.post('/api/maestro/examen', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { grupoId, tareaIds, titulo, instrucciones, preguntasPorTarea, tiempoLimite, fechaVencimiento } = req.body;
        if (!tareaIds?.length) return res.status(400).json({ error: 'Selecciona al menos una tarea.' });

        // Obtener tareas y mezclar preguntas
        const tareas = await Tarea.find({
            _id: { $in: tareaIds },
            maestroId: req.maestro.id
        }).select('titulo poolPreguntas grupoId').lean();

        if (!tareas.length) return res.status(404).json({ error: 'No se encontraron tareas.' });
        if (tareas.length !== tareaIds.length) return res.status(403).json({ error: 'Una o mas tareas no pertenecen a tu cuenta.' });
        const grupoIdFinal = grupoId || tareas.find(t => t.grupoId)?.grupoId;
        if (!grupoIdFinal) return res.status(400).json({ error: 'Las tareas del examen deben estar asignadas a un grupo.' });
        const tareasOtroGrupo = tareas.some(t => String(t.grupoId || '') !== String(grupoIdFinal));
        if (tareasOtroGrupo) return res.status(400).json({ error: 'Selecciona tareas del mismo grupo para crear el examen.' });

        const grupo = await Grupo.findOne({ _id: grupoIdFinal, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const ppt = preguntasPorTarea || 5; // preguntas por tarea
        let preguntas = [];
        tareas.forEach(t => {
            const pool = normalizeQuestions(t.poolPreguntas || []);
            // Mezclar aleatoriamente y tomar ppt preguntas
            const mezcladas = pool.sort(() => Math.random() - 0.5).slice(0, ppt);
            mezcladas.forEach(q => preguntas.push({ ...q, fuente: t.titulo }));
        });
        // Mezclar el examen completo
        preguntas = preguntas.sort(() => Math.random() - 0.5);

        const shortId = await shortIdUnico(Examen);
        const examen = await Examen.create({
            shortId, maestroId: req.maestro.id, grupoId: grupoIdFinal,
            titulo: titulo || `Examen Final — ${grupo.nombre}`,
            instrucciones: instrucciones || 'Responde cada pregunta. Tienes tiempo limitado.',
            preguntas, tiempoLimite: tiempoLimite || 60,
            fechaVencimiento: parseOptionalDate(fechaVencimiento),
            origen: 'tareas',
            activo: true
        });
        res.json({ shortId: examen.shortId, titulo: examen.titulo, totalPreguntas: preguntas.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/maestro/examen-archivo', verifyToken, upload.array('archivos', 10), async (req, res) => {
    const archivos = req.files || [];
    const tmpPaths = archivos.map(f => f.path);
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        if (!archivos.length) return res.status(400).json({ error: 'No se recibieron archivos.' });
        const { grupoId, titulo, instrucciones, preguntasPorTarea, tiempoLimite, fechaVencimiento } = req.body;
        const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        let textoTotal = '';
        for (const archivo of archivos) {
            const buf = await readFile(archivo.path);
            const mime = archivo.mimetype;
            let texto = '';
            if (mime === 'application/pdf') {
                try { texto = (await pdfParse(buf)).text; } catch { texto = ''; }
            } else if (mime.startsWith('image/')) {
                texto = await extractImageText(buf, mime);
            } else {
                texto = buf.toString('utf-8');
            }
            if (texto.trim()) textoTotal += texto + '\n\n';
        }
        if (!textoTotal.trim() || textoTotal.trim().length < 30)
            throw new Error('No se encontró suficiente texto en los archivos.');

        const generated = await procesarConIAPool(textoTotal, {
            maestroId: req.maestro.id, tipo: 'tarea',
            materia: grupo.materia, semestre: grupo.semestre
        });
        const ppt = Math.max(1, Math.min(parseInt(preguntasPorTarea) || 10, 20));
        const preguntas = normalizeQuestions(generated.poolPreguntas || generated.quiz || []).slice(0, ppt);
        if (!preguntas.length) throw new Error('La IA no generó preguntas suficientes para el examen.');

        const shortId = await shortIdUnico(Examen);
        const examen = await Examen.create({
            shortId, maestroId: req.maestro.id, grupoId,
            titulo: titulo || generated.titulo || `Examen — ${grupo.nombre}`,
            instrucciones: instrucciones || 'Responde cada pregunta. Tienes tiempo limitado.',
            preguntas, tiempoLimite: parseInt(tiempoLimite) || 60,
            fechaVencimiento: parseOptionalDate(fechaVencimiento),
            origen: 'archivo',
            fuenteTexto: textoTotal.substring(0, 10000),
            activo: true
        });
        res.json({ shortId: examen.shortId, titulo: examen.titulo, totalPreguntas: preguntas.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
    finally { for (const p of tmpPaths) await unlink(p).catch(() => {}); }
});

// Listar exámenes del maestro
app.get('/api/maestro/examenes', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const examenes = await Examen.find({ maestroId: req.maestro.id })
            .sort({ creadoEn: -1 }).select('-preguntas').lean();
        const entregaCounts = await Promise.all(examenes.map(e => ExamenEntrega.countDocuments({ examenId: e._id })));
        examenes.forEach((e, i) => { e.entregas = entregaCounts[i]; });
        const grupos = await Grupo.find({ maestroId: req.maestro.id }).select('_id nombre').lean();
        res.json({ examenes, grupos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Obtener examen (alumno) — sin respuestas correctas
app.get('/api/examen/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const examen = await Examen.findOne({ shortId: req.params.shortId, activo: true }).lean();
        if (!examen) return res.status(404).json({ error: 'Examen no encontrado o inactivo.' });
        // Ocultar respuestas correctas al alumno
        const preguntasSinRespuesta = normalizeQuestions(examen.preguntas).map(q => ({
            p: q.p, o: q.o, fuente: q.fuente, bloom: q.bloom // sin q.r ni explicacion antes de entregar
        }));
        const estado = lateInfo(examen.fechaVencimiento);
        res.json({ ...examen, preguntas: preguntasSinRespuesta, entregaTarde: estado.entregaTarde, retrasoMinutos: estado.retrasoMinutos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/examen/:shortId/entregar', verifyAlumno, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const examen = await Examen.findOne({ shortId: req.params.shortId, activo: true });
        if (!examen) return res.status(404).json({ error: 'Examen no encontrado o inactivo.' });
        const alumno = await Alumno.findById(req.alumno.id).select('nombre grupoId').lean();
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });
        if (examen.grupoId && alumno.grupoId && String(examen.grupoId) !== String(alumno.grupoId)) {
            return res.status(403).json({ error: 'Este examen no pertenece a tu grupo.' });
        }
        const entregaExistente = await ExamenEntrega.findOne({ examenId: examen._id, alumnoId: alumno._id })
            .select('shortId respuestas correctas total pct entregaTarde retrasoMinutos').lean();
        if (entregaExistente) {
            return res.json({
                shortId: entregaExistente.shortId,
                detalles: entregaExistente.respuestas || [],
                correctas: entregaExistente.correctas,
                total: entregaExistente.total,
                pct: entregaExistente.pct,
                entregaTarde: entregaExistente.entregaTarde,
                retrasoMinutos: entregaExistente.retrasoMinutos,
                retrasoTexto: formatRetraso(entregaExistente.retrasoMinutos),
                yaEntregado: true
            });
        }
        const respuestasInput = req.body.respuestas || {};
        let correctas = 0;
        const preguntasNormalizadas = normalizeQuestions(examen.preguntas);
        const respuestas = preguntasNormalizadas.map((q, i) => {
            const raw = respuestasInput[i];
            const seleccionada = (raw === undefined || raw === null || raw === '') ? null : Number(raw);
            const esCorrecta = Number.isInteger(seleccionada) && seleccionada === q.r;
            if (esCorrecta) correctas++;
            return {
                pregunta: q.p,
                opciones: q.o || [],
                seleccionada,
                correcta: q.r,
                esCorrecta,
                fuente: q.fuente || '',
                bloom: q.bloom || '',
                explicacion: q.explicacion || explicacionFallback(q)
            };
        });
        const total = preguntasNormalizadas.length;
        const pct = total ? Math.round((correctas / total) * 100) : 0;
        const estado = lateInfo(examen.fechaVencimiento);
        const shortId = await shortIdUnico(ExamenEntrega);
        const entrega = await ExamenEntrega.create({
            shortId, examenId: examen._id, alumnoId: alumno._id,
            nombre: alumno.nombre, grupoId: examen.grupoId || alumno.grupoId,
            respuestas, correctas, total, pct, ...estado
        });
        res.json({
            shortId: entrega.shortId, detalles: respuestas, correctas, total, pct,
            entregaTarde: estado.entregaTarde,
            retrasoMinutos: estado.retrasoMinutos,
            retrasoTexto: formatRetraso(estado.retrasoMinutos)
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/maestro/examen/:shortId/entregas', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const examen = await Examen.findOne({ shortId: req.params.shortId, maestroId: req.maestro.id }).select('_id titulo');
        if (!examen) return res.status(404).json({ error: 'Examen no encontrado.' });
        const entregas = await ExamenEntrega.find({ examenId: examen._id })
            .sort({ creadoEn: -1 }).select('-respuestas').lean();
        res.json({ examen: { shortId: req.params.shortId, titulo: examen.titulo }, entregas });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Desactivar examen
app.patch('/api/maestro/examen/:shortId/estado', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { activo } = req.body;
        const examen = await Examen.findOneAndUpdate(
            { shortId: req.params.shortId, maestroId: req.maestro.id },
            { activo }, { new: true }
        );
        if (!examen) return res.status(404).json({ error: 'Examen no encontrado.' });
        res.json({ ok: true, activo: examen.activo });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ QUIZ EN VIVO (SSE) ══

// Mapa en memoria de salas activas y sus clientes SSE
const salasSSE = new Map(); // salaId → [{ res, nombre }]

// Crear sala de quiz en vivo
app.post('/api/maestro/quiz-vivo', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { grupoId, tareaId, titulo } = req.body;
        if (!grupoId || !tareaId) return res.status(400).json({ error: 'Falta grupo o tarea.' });

        const tarea = await Tarea.findOne({ _id: tareaId, maestroId: req.maestro.id }).lean();
        if (!tarea) return res.status(404).json({ error: 'Tarea no encontrada.' });

        // Generar código de sala de 4 letras
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        let codigo = '';
        do {
            codigo = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
        } while (await SalaQuiz.findOne({ codigo, estado: { $ne: 'terminada' } }));

        const preguntas = (tarea.poolPreguntas || []).sort(() => Math.random() - 0.5).slice(0, 10);
        const sala = await SalaQuiz.create({
            codigo, maestroId: req.maestro.id, grupoId,
            titulo: titulo || tarea.titulo, preguntas,
            preguntaActual: -1, estado: 'esperando'
        });
        res.json({ codigo: sala.codigo, _id: sala._id, titulo: sala.titulo, totalPreguntas: preguntas.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// SSE — alumno se une a la sala
app.get('/api/quiz-vivo/:codigo/stream', async (req, res) => {
    try {
        const sala = await SalaQuiz.findOne({ codigo: req.params.codigo.toUpperCase(), estado: { $ne: 'terminada' } });
        if (!sala) return res.status(404).json({ error: 'Sala no encontrada.' });

        const nombre = req.query.nombre || 'Anónimo';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.flushHeaders();

        // Registrar cliente
        if (!salasSSE.has(sala.codigo)) salasSSE.set(sala.codigo, []);
        const clientes = salasSSE.get(sala.codigo);
        const cliente = { res, nombre };
        clientes.push(cliente);

        // Enviar estado inicial
        const estadoActual = await SalaQuiz.findById(sala._id).lean();
        res.write(`data: ${JSON.stringify({ tipo: 'unido', estado: estadoActual.estado, preguntaActual: estadoActual.preguntaActual, totalAlumnos: clientes.length, nombre })}\n\n`);

        // Notificar a todos que llegó alguien nuevo
        broadcastSala(sala.codigo, { tipo: 'nuevo_alumno', nombre, totalAlumnos: clientes.length });

        // Cleanup al desconectarse
        req.on('close', () => {
            const idx = clientes.indexOf(cliente);
            if (idx > -1) clientes.splice(idx, 1);
            if (clientes.length === 0) salasSSE.delete(sala.codigo);
        });

        // Keep-alive cada 25s
        const keepAlive = setInterval(() => {
            try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
        }, 25000);
        req.on('close', () => clearInterval(keepAlive));
    } catch(e) { res.status(500).json({ error: e.message }); }
});

function broadcastSala(codigo, data) {
    const clientes = salasSSE.get(codigo) || [];
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    clientes.forEach(c => { try { c.res.write(msg); } catch {} });
}

// Maestro controla el quiz (avanzar pregunta, terminar)
app.post('/api/maestro/quiz-vivo/:codigo/control', verifyToken, async (req, res) => {
    try {
        const { accion } = req.body; // 'siguiente', 'terminar', 'iniciar'
        const sala = await SalaQuiz.findOne({ codigo: req.params.codigo.toUpperCase(), maestroId: req.maestro.id });
        if (!sala) return res.status(404).json({ error: 'Sala no encontrada.' });

        if (accion === 'iniciar' || accion === 'siguiente') {
            const siguiente = sala.preguntaActual + 1;
            if (siguiente >= sala.preguntas.length) {
                sala.estado = 'terminada';
                await sala.save();
                broadcastSala(sala.codigo, { tipo: 'fin', mensaje: '¡Quiz terminado!' });
                return res.json({ ok: true, estado: 'terminada' });
            }
            sala.preguntaActual = siguiente;
            sala.estado = 'activa';
            await sala.save();
            // Enviar pregunta SIN respuesta correcta
            const q = sala.preguntas[siguiente];
            broadcastSala(sala.codigo, {
                tipo: 'pregunta',
                idx: siguiente,
                total: sala.preguntas.length,
                pregunta: { p: q.p, o: q.o }, // sin q.r
                tiempoSegundos: 20
            });
            return res.json({ ok: true, preguntaActual: siguiente });
        }

        if (accion === 'terminar') {
            sala.estado = 'terminada';
            await sala.save();
            // Calcular ranking final
            const ranking = calcularRankingQuiz(sala);
            broadcastSala(sala.codigo, { tipo: 'fin', ranking });
            return res.json({ ok: true, ranking });
        }
        res.status(400).json({ error: 'Acción inválida.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Alumno responde pregunta del quiz en vivo
app.post('/api/quiz-vivo/:codigo/responder', async (req, res) => {
    try {
        const { nombre, preguntaIdx, opcion, tiempo } = req.body;
        const sala = await SalaQuiz.findOne({ codigo: req.params.codigo.toUpperCase(), estado: 'activa' });
        if (!sala) return res.status(404).json({ error: 'Sala no activa.' });
        if (preguntaIdx !== sala.preguntaActual) return res.status(400).json({ error: 'Pregunta incorrecta.' });

        // Verificar si ya respondió esta pregunta
        const yaRespondio = sala.respuestas.some(r => r.alumno === nombre && r.preguntaIdx === preguntaIdx);
        if (yaRespondio) return res.status(409).json({ error: 'Ya respondiste esta pregunta.' });

        const q = sala.preguntas[preguntaIdx];
        const esCorrecta = opcion === q.r;
        sala.respuestas.push({ alumno: nombre, preguntaIdx, opcion, esCorrecta, tiempo: tiempo || 0 });
        await sala.save();

        // Notificar al maestro que alguien respondió
        const totalRespuestas = sala.respuestas.filter(r => r.preguntaIdx === preguntaIdx).length;
        const totalAlumnos = (salasSSE.get(sala.codigo) || []).length;
        broadcastSala(sala.codigo, {
            tipo: 'respuesta_recibida',
            totalRespuestas, totalAlumnos, alumno: nombre, esCorrecta
        });

        res.json({ ok: true, esCorrecta, respuestaCorrecta: q.r });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Estado de la sala (para el maestro)
app.get('/api/maestro/quiz-vivo/:codigo', verifyToken, async (req, res) => {
    try {
        const sala = await SalaQuiz.findOne({ codigo: req.params.codigo.toUpperCase(), maestroId: req.maestro.id }).lean();
        if (!sala) return res.status(404).json({ error: 'Sala no encontrada.' });
        const ranking = calcularRankingQuiz(sala);
        const totalConectados = (salasSSE.get(sala.codigo) || []).length;
        res.json({ ...sala, ranking, totalConectados });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

function calcularRankingQuiz(sala) {
    const scores = {};
    sala.respuestas.forEach(r => {
        if (!scores[r.alumno]) scores[r.alumno] = { nombre: r.alumno, correctas: 0, tiempoTotal: 0 };
        if (r.esCorrecta) scores[r.alumno].correctas++;
        scores[r.alumno].tiempoTotal += r.tiempo || 0;
    });
    return Object.values(scores)
        .sort((a, b) => b.correctas - a.correctas || a.tiempoTotal - b.tiempoTotal)
        .map((s, i) => ({ ...s, posicion: i + 1 }));
}

// ══ REPORTE PDF PARA PADRES ══
app.get('/api/maestro/reporte-padres/:grupoId/:nombre', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const grupo = await Grupo.findOne({ _id: req.params.grupoId, maestroId: req.maestro.id }).lean();
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const nombre = decodeURIComponent(req.params.nombre);
        const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const sesiones = await Sesion.find({
            grupoId: grupo._id,
            nombre: { $regex: new RegExp(nombre, 'i') },
            creadoEn: { $gte: hace30 }
        }).sort({ creadoEn: 1 }).select('-chatMensajes -tarjetasAbiertas').lean();

        const promedio = sesiones.length
            ? Math.round(sesiones.reduce((a, s) => a + (s.pct || 0), 0) / sesiones.length) : 0;
        const sesionesSemana = sesiones.filter(s => new Date(s.creadoEn) >= new Date(Date.now() - 7*24*60*60*1000)).length;
        const hoy = new Date().toLocaleDateString('es-MX', { year:'numeric', month:'long', day:'numeric' });

        const colorPromedio = promedio >= 80 ? '#059669' : promedio >= 60 ? '#d97706' : '#dc2626';
        const estrellas = promedio >= 90 ? '⭐⭐⭐⭐⭐' : promedio >= 80 ? '⭐⭐⭐⭐' : promedio >= 70 ? '⭐⭐⭐' : promedio >= 60 ? '⭐⭐' : '⭐';

        const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Reporte de Progreso — ${nombre}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a2235; background: white; }
  .page { max-width: 750px; margin: 0 auto; padding: 40px 40px 60px; }
  .header { background: linear-gradient(135deg, #0f2060, #1a3a8f, #7c3aed); color: white; border-radius: 16px; padding: 28px 32px; margin-bottom: 28px; display: flex; align-items: center; gap: 20px; }
  .header-logo { font-size: 2.5rem; }
  .header h1 { font-size: 1.2rem; font-weight: 800; margin-bottom: 4px; }
  .header p { font-size: 0.78rem; opacity: 0.75; }
  .fecha { font-size: 0.75rem; opacity: 0.65; margin-top: 6px; }
  .alumno-box { background: #f0f4ff; border-left: 5px solid #1a3a8f; border-radius: 0 12px 12px 0; padding: 18px 22px; margin-bottom: 24px; }
  .alumno-box h2 { font-size: 1.1rem; color: #0f2060; margin-bottom: 4px; }
  .alumno-box p { font-size: 0.82rem; color: #4a5568; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; text-align: center; }
  .kpi-val { font-size: 1.6rem; font-weight: 800; margin-bottom: 2px; }
  .kpi-label { font-size: 0.68rem; color: #718096; text-transform: uppercase; letter-spacing: 0.06em; }
  .section-title { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #718096; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  .sesion-row { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 8px; margin-bottom: 4px; }
  .sesion-row:nth-child(even) { background: #f8fafc; }
  .sesion-fecha { font-size: 0.72rem; color: #718096; min-width: 80px; }
  .sesion-titulo { flex: 1; font-size: 0.82rem; color: #2d3748; }
  .sesion-pct { font-weight: 800; font-size: 0.88rem; min-width: 40px; text-align: right; }
  .mensaje { background: #f0fdf4; border: 1px solid #86efac; border-radius: 12px; padding: 16px 20px; margin-top: 24px; }
  .mensaje p { font-size: 0.85rem; color: #166534; line-height: 1.6; }
  .footer { text-align: center; margin-top: 32px; font-size: 0.7rem; color: #a0aec0; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-logo">📊</div>
    <div>
      <h1>Reporte de Progreso Académico</h1>
      <p>Tutor IA — Powered by Brand Collective</p>
      <p class="fecha">Generado el ${hoy}</p>
    </div>
  </div>

  <div class="alumno-box">
    <h2>👤 ${nombre}</h2>
    <p>${grupo.nombre} · ${grupo.semestre} · ${grupo.materia}</p>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-val" style="color:${colorPromedio}">${promedio}%</div>
      <div class="kpi-label">Promedio general</div>
    </div>
    <div class="kpi">
      <div class="kpi-val" style="color:#1a3a8f">${sesiones.length}</div>
      <div class="kpi-label">Sesiones completadas</div>
    </div>
    <div class="kpi">
      <div class="kpi-val" style="color:#7c3aed">${sesionesSemana}</div>
      <div class="kpi-label">Esta semana</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">${estrellas}</div>
      <div class="kpi-label">Calificación</div>
    </div>
  </div>

  <div style="margin-bottom:24px">
    <div class="section-title">Historial de sesiones — últimos 30 días</div>
    ${sesiones.length ? sesiones.map(s => {
        const c = s.pct >= 80 ? '#059669' : s.pct >= 60 ? '#d97706' : '#dc2626';
        return `<div class="sesion-row">
            <div class="sesion-fecha">${s.fecha || ''}</div>
            <div class="sesion-titulo">${s.titulo || ''}</div>
            <div class="sesion-pct" style="color:${c}">${s.pct}%</div>
        </div>`;
    }).join('') : '<p style="color:#718096;font-size:.82rem;padding:12px">Sin sesiones registradas en este período.</p>'}
  </div>

  <div class="mensaje">
    <p><strong>Estimado padre/madre de familia:</strong><br>
    Este reporte muestra el progreso académico de <strong>${nombre}</strong> durante el último mes en la plataforma Tutor IA. 
    ${promedio >= 80 ? '¡Su desempeño es excelente! Sigue apoyando este esfuerzo en casa.' : promedio >= 60 ? 'Su desempeño es satisfactorio. Le recomendamos reforzar el estudio diario.' : 'Le invitamos a apoyar a su hijo/a con mayor tiempo de estudio en casa.'}
    </p>
  </div>

  <div class="footer">
    Tutor IA · Brand Collective · brandcollectivemx.com<br>
    Este reporte fue generado automáticamente — ${hoy}
  </div>
</div>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Notificar al maestro cuando un alumno entrega sesión (hook en /api/sesion)
// Ya existe el endpoint, solo agregamos la llamada de notificación
// ══ RESET DE CONTRASEÑA ══

// ── Función centralizada de envío de email via Resend
async function enviarEmailReset(destinatario, nombre, resetUrl, rol) {
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return false;
    const rolLabel = rol === 'maestro' ? 'Maestro' : rol === 'director' ? 'Director' : 'Alumno';
    await axios.post('https://api.resend.com/emails', {
        from:    'Tutor IA <no-reply@brandcollectivemx.com>',
        to:      [destinatario],
        subject: 'Restablecer contraseña — Tutor IA',
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#080b14;color:#edf0f7;border-radius:16px">
            <h2 style="color:#a78bfa;margin-bottom:8px">🔐 Restablecer contraseña</h2>
            <p style="color:#8892a4;margin-bottom:8px">Hola <strong>${nombre}</strong>, recibimos tu solicitud para restablecer tu contraseña de <strong>${rolLabel}</strong>.</p>
            <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:#7c3aed;color:white;border-radius:10px;text-decoration:none;font-weight:700;margin:16px 0">Restablecer contraseña</a>
            <p style="color:#5e738a;font-size:.82rem">Este link expira en 1 hora. Si no solicitaste esto, ignora este mensaje.</p>
            <hr style="border:none;border-top:1px solid #1e2d45;margin:20px 0">
            <p style="color:#5e738a;font-size:.75rem">Tutor IA · Brand Collective MX</p>
        </div>`
    }, { headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' } });
    return true;
}

// ── Reset de contraseña para ALUMNOS
app.post('/api/alumno/reset-password', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email requerido.' });
        const alumno = await Alumno.findOne({ email: email.toLowerCase() });
        if (!alumno) return res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
        const token = [...Array(32)].map(() => Math.floor(Math.random()*16).toString(16)).join('');
        alumno.resetToken    = token;
        alumno.resetTokenExp = new Date(Date.now() + 60*60*1000);
        await alumno.save();
        const resetUrl = `${process.env.FRONTEND_URL || 'https://brandcollectivemx.com/tutor'}?reset=${token}&rol=alumno`;
        await enviarEmailReset(alumno.email, alumno.nombre, resetUrl, 'alumno').catch(() => {});
        res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/alumno/confirm-reset', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos.' });
        if (password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres.' });
        const alumno = await Alumno.findOne({ resetToken: token, resetTokenExp: { $gt: new Date() } });
        if (!alumno) return res.status(400).json({ error: 'Token inválido o expirado.' });
        alumno.passwordHash  = await bcrypt.hash(password, 10);
        alumno.resetToken    = null;
        alumno.resetTokenExp = null;
        await alumno.save();
        res.json({ ok: true, msg: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset de contraseña para MAESTROS
app.post('/api/maestro/reset-password', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email requerido.' });
        const maestro = await Maestro.findOne({ email: email.toLowerCase() });
        if (!maestro) return res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
        const token = [...Array(32)].map(() => Math.floor(Math.random()*16).toString(16)).join('');
        maestro.resetToken    = token;
        maestro.resetTokenExp = new Date(Date.now() + 60*60*1000);
        await maestro.save();
        const resetUrl = `${process.env.FRONTEND_URL || 'https://brandcollectivemx.com/tutor'}?reset=${token}&rol=maestro`;
        await enviarEmailReset(maestro.email, maestro.nombre, resetUrl, 'maestro').catch(() => {});
        res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/maestro/confirm-reset', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos.' });
        if (password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres.' });
        const maestro = await Maestro.findOne({ resetToken: token, resetTokenExp: { $gt: new Date() } });
        if (!maestro) return res.status(400).json({ error: 'Token inválido o expirado.' });
        maestro.passwordHash  = await bcrypt.hash(password, 10);
        maestro.resetToken    = null;
        maestro.resetTokenExp = null;
        await maestro.save();
        res.json({ ok: true, msg: 'Contraseña actualizada. Ya puedes iniciar sesión como maestro.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset de contraseña para DIRECTORES
app.post('/api/director/reset-password', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email requerido.' });
        const director = await Director.findOne({ email: email.toLowerCase() });
        if (!director) return res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
        const token = [...Array(32)].map(() => Math.floor(Math.random()*16).toString(16)).join('');
        director.resetToken    = token;
        director.resetTokenExp = new Date(Date.now() + 60*60*1000);
        await director.save();
        const resetUrl = `${process.env.FRONTEND_URL || 'https://brandcollectivemx.com/tutor'}?reset=${token}&rol=director`;
        await enviarEmailReset(director.email, director.nombre, resetUrl, 'director').catch(() => {});
        res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/director/confirm-reset', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos.' });
        if (password.length < 6) return res.status(400).json({ error: 'Mínimo 6 caracteres.' });
        const director = await Director.findOne({ resetToken: token, resetTokenExp: { $gt: new Date() } });
        if (!director) return res.status(400).json({ error: 'Token inválido o expirado.' });
        director.passwordHash  = await bcrypt.hash(password, 10);
        director.resetToken    = null;
        director.resetTokenExp = null;
        await director.save();
        res.json({ ok: true, msg: 'Contraseña actualizada. Ya puedes iniciar sesión como director.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});



// ══ LOGROS DESBLOQUEABLES ══

// Definición de todos los logros posibles
const LOGROS_DEF = [
    { id: 'primera_sesion',   emoji: '🎉', titulo: '¡Primer paso!',         desc: 'Completaste tu primera sesión de estudio' },
    { id: 'racha_3',          emoji: '🔥', titulo: 'En racha',               desc: '3 días seguidos estudiando' },
    { id: 'racha_7',          emoji: '💫', titulo: 'Semana completa',        desc: '7 días seguidos estudiando' },
    { id: 'racha_30',         emoji: '🏆', titulo: 'Imparable',              desc: '30 días seguidos estudiando' },
    { id: 'perfecto',         emoji: '⭐', titulo: '¡Perfecto!',             desc: 'Obtuviste 100% en un quiz' },
    { id: 'perfecto_3',       emoji: '✨', titulo: 'Triple perfecto',        desc: '100% en 3 quizzes consecutivos' },
    { id: 'sesiones_10',      emoji: '📚', titulo: 'Estudioso',              desc: '10 sesiones completadas' },
    { id: 'sesiones_50',      emoji: '🎓', titulo: 'Dedicado',               desc: '50 sesiones completadas' },
    { id: 'sesiones_100',     emoji: '🌟', titulo: 'Experto',                desc: '100 sesiones completadas' },
    { id: 'primer_examen',    emoji: '📝', titulo: 'Primer examen',          desc: 'Completaste tu primer examen final' },
    { id: 'quiz_vivo',        emoji: '⚡', titulo: 'En vivo',                desc: 'Participaste en un quiz en vivo' },
    { id: 'madrugador',       emoji: '🌅', titulo: 'Madrugador',             desc: 'Estudió antes de las 7am' },
    { id: 'nocturno',         emoji: '🌙', titulo: 'Búho nocturno',          desc: 'Estudió después de las 11pm' },
    { id: 'podcast',          emoji: '🎧', titulo: 'Audiófilo',              desc: 'Escuchó 10 podcasts de clase' },
    { id: 'flashcards',       emoji: '🃏', titulo: 'Memorizador',            desc: 'Revisó 50 tarjetas de memoria' },
];

// Verificar y otorgar logros a un alumno
async function verificarLogros(alumnoId, stats = {}) {
    try {
        const alumno = await Alumno.findById(alumnoId).lean();
        if (!alumno) return [];
        const yaDesbloqueados = new Set(alumno.logros || []);
        const nuevos = [];

        const { totalSesiones = 0, pct = 0, rachaActual = 0,
                consecutivosPerfectos = 0, hora = '', podcasts = 0, flashcards = 0 } = stats;

        const check = (id, condicion) => {
            if (!yaDesbloqueados.has(id) && condicion) nuevos.push(id);
        };

        check('primera_sesion',   totalSesiones >= 1);
        check('racha_3',          rachaActual >= 3);
        check('racha_7',          rachaActual >= 7);
        check('racha_30',         rachaActual >= 30);
        check('perfecto',         pct === 100);
        check('perfecto_3',       consecutivosPerfectos >= 3);
        check('sesiones_10',      totalSesiones >= 10);
        check('sesiones_50',      totalSesiones >= 50);
        check('sesiones_100',     totalSesiones >= 100);
        check('madrugador',       parseInt(hora?.split(':')[0] || '12') < 7);
        check('nocturno',         parseInt(hora?.split(':')[0] || '12') >= 23);
        check('podcast',          podcasts >= 10);
        check('flashcards',       flashcards >= 50);

        if (nuevos.length) {
            await Alumno.findByIdAndUpdate(alumnoId, { $addToSet: { logros: { $each: nuevos } } });
        }
        return nuevos.map(id => LOGROS_DEF.find(l => l.id === id)).filter(Boolean);
    } catch(e) { return []; }
}

// Endpoint: logros del alumno
app.get('/api/alumno/logros', verifyAlumno, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const alumno = await Alumno.findById(req.alumno.id).select('logros nombre').lean();
        if (!alumno) return res.status(404).json({ error: 'Alumno no encontrado.' });

        const desbloqueados = (alumno.logros || []).map(id => LOGROS_DEF.find(l => l.id === id)).filter(Boolean);
        const pendientes = LOGROS_DEF.filter(l => !(alumno.logros || []).includes(l.id));
        res.json({ desbloqueados, pendientes, total: LOGROS_DEF.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ DASHBOARD DE ESTADÍSTICAS ADMIN (Brand Collective) ══
app.get('/api/admin/stats-uso', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });

        const hace30  = new Date(Date.now() - 30  * 24 * 60 * 60 * 1000);
        const hace7   = new Date(Date.now() - 7   * 24 * 60 * 60 * 1000);
        const hoy     = new Date(new Date().setHours(0,0,0,0));

        // Stats generales
        const [totalEscuelas, totalMaestros, totalAlumnos,
               sesionesHoy, sesiones7d, sesiones30d] = await Promise.all([
            Escuela.countDocuments(),
            Maestro.countDocuments(),
            Alumno.countDocuments({ activo: true }),
            Sesion.countDocuments({ creadoEn: { $gte: hoy } }),
            Sesion.countDocuments({ creadoEn: { $gte: hace7 } }),
            Sesion.countDocuments({ creadoEn: { $gte: hace30 } }),
        ]);

        // Tokens y costo
        const usagePipeline = await UsageLog.aggregate([
            { $match: { creadoEn: { $gte: hace30 } } },
            { $group: {
                _id: null,
                tokensTotal:  { $sum: '$tokensTotal' },
                costoTotal:   { $sum: '$costoUSD' },
                llamadas: { $sum: 1 }
            }}
        ]);
        const usage30d = usagePipeline[0] || { tokensTotal: 0, costoTotal: 0, llamadas: 0 };

        // Uso por escuela
        const usagePorEscuela = await UsageLog.aggregate([
            { $match: { creadoEn: { $gte: hace30 }, escuelaId: { $ne: null } } },
            { $group: { _id: '$escuelaId', tokens: { $sum: '$tokensTotal' }, costo: { $sum: '$costoUSD' }, llamadas: { $sum: 1 } } },
            { $sort: { tokens: -1 } },
            { $limit: 10 }
        ]);
        const escuelaIds = usagePorEscuela.map(u => u._id);
        const escuelas = await Escuela.find({ _id: { $in: escuelaIds } }).select('nombre ciudad').lean();
        const escuelasMap = Object.fromEntries(escuelas.map(e => [e._id.toString(), e]));
        const usagePorEscuelaConNombre = usagePorEscuela.map(u => ({
            ...u,
            escuela: escuelasMap[u._id?.toString()] || { nombre: 'Sin escuela', ciudad: '' }
        }));

        // Sesiones por día (últimos 14 días)
        const sesionesPorDia = await Sesion.aggregate([
            { $match: { creadoEn: { $gte: new Date(Date.now() - 14*24*60*60*1000) } } },
            { $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$creadoEn' } },
                count: { $sum: 1 }
            }},
            { $sort: { _id: 1 } }
        ]);

        // Uso por tipo
        const usagePorTipo = await UsageLog.aggregate([
            { $match: { creadoEn: { $gte: hace30 } } },
            { $group: { _id: '$tipo', tokens: { $sum: '$tokensTotal' }, costo: { $sum: '$costoUSD' } } },
            { $sort: { tokens: -1 } }
        ]);

        res.json({
            resumen: { totalEscuelas, totalMaestros, totalAlumnos, sesionesHoy, sesiones7d, sesiones30d },
            tokens: {
                total30d:  usage30d.tokensTotal,
                costo30d:  parseFloat(usage30d.costoTotal.toFixed(4)),
                llamadas30d: usage30d.llamadas,
                costoPorSesion: sesiones30d > 0 ? parseFloat((usage30d.costoTotal / sesiones30d).toFixed(5)) : 0
            },
            porEscuela: usagePorEscuelaConNombre,
            sesionesPorDia,
            porTipo: usagePorTipo
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ RETO SEMANAL ══
const retoSchema = new mongoose.Schema({
    shortId:      { type: String, unique: true, index: true },
    maestroId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    grupoId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    titulo:       String,
    descripcion:  String,
    preguntas:    [Object],     // pool mezclado
    tiempoLimite: { type: Number, default: 30 },  // minutos
    activo:       { type: Boolean, default: true },
    fechaFin:     { type: Date },                 // cuándo expira
    participantes: [{ // resultados de cada alumno
        alumno:   String,
        alumnoId: mongoose.Schema.Types.ObjectId,
        pct:      Number,
        correctas: Number,
        total:    Number,
        tiempo:   Number,       // segundos usados
        completadoEn: { type: Date, default: Date.now }
    }],
    creadoEn: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 } // 14 días TTL
});
const Reto = mongoose.models.Reto || mongoose.model('Reto', retoSchema);

// Crear reto semanal
app.post('/api/maestro/reto', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { grupoId, tareaIds, titulo, descripcion, preguntasPorTarea, tiempoLimite, diasDuracion } = req.body;
        if (!tareaIds?.length) return res.status(400).json({ error: 'Selecciona al menos una tarea.' });

        const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const tareas = await Tarea.find({ _id: { $in: tareaIds }, maestroId: req.maestro.id }).lean();
        if (!tareas.length) return res.status(404).json({ error: 'Tareas no encontradas.' });

        const ppt = Math.min(preguntasPorTarea || 5, 10);
        let preguntas = [];
        tareas.forEach(t => {
            const pool = (t.poolPreguntas || []).sort(() => Math.random() - 0.5).slice(0, ppt);
            preguntas = preguntas.concat(pool.map(q => ({ ...q, fuente: t.titulo })));
        });
        preguntas = preguntas.sort(() => Math.random() - 0.5);

        const dias = Math.min(diasDuracion || 7, 14);
        const shortId = await shortIdUnico(Reto);
        const reto = await Reto.create({
            shortId, maestroId: req.maestro.id, grupoId,
            titulo: titulo || `🏆 Reto Semanal — ${grupo.nombre}`,
            descripcion: descripcion || `Demuestra todo lo que sabes. Tienes ${dias} día${dias>1?'s':''} para completarlo.`,
            preguntas, tiempoLimite: tiempoLimite || 30,
            activo: true,
            fechaFin: new Date(Date.now() + dias * 24 * 60 * 60 * 1000),
            participantes: []
        });
        res.json({ shortId: reto.shortId, titulo: reto.titulo, totalPreguntas: preguntas.length, fechaFin: reto.fechaFin });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar retos del maestro
app.get('/api/maestro/retos', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const retos = await Reto.find({ maestroId: req.maestro.id })
            .sort({ creadoEn: -1 }).select('-preguntas').lean();
        res.json({ retos });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Obtener reto (alumno) — sin respuestas correctas
app.get('/api/reto/:shortId', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const reto = await Reto.findOne({ shortId: req.params.shortId, activo: true }).lean();
        if (!reto) return res.status(404).json({ error: 'Reto no encontrado o expirado.' });
        if (reto.fechaFin && new Date() > new Date(reto.fechaFin))
            return res.status(410).json({ error: 'Este reto ya expiró.' });

        // Calcular ranking actual
        const ranking = [...(reto.participantes || [])].sort((a,b) => {
            if (b.pct !== a.pct) return b.pct - a.pct;
            return a.tiempo - b.tiempo; // menor tiempo desempata
        }).map((p, i) => ({ posicion: i+1, alumno: p.alumno, pct: p.pct, correctas: p.correctas, tiempo: p.tiempo }));

        res.json({
            shortId: reto.shortId, titulo: reto.titulo, descripcion: reto.descripcion,
            totalPreguntas: reto.preguntas.length, tiempoLimite: reto.tiempoLimite,
            fechaFin: reto.fechaFin, ranking,
            preguntas: reto.preguntas.map(q => ({ p: q.p, o: q.o, fuente: q.fuente })) // sin q.r
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Entregar reto (alumno)
app.post('/api/reto/:shortId/entregar', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { alumno, alumnoId, respuestas, tiempoUsado } = req.body;
        if (!alumno) return res.status(400).json({ error: 'Falta el nombre del alumno.' });

        const reto = await Reto.findOne({ shortId: req.params.shortId, activo: true });
        if (!reto) return res.status(404).json({ error: 'Reto no encontrado.' });
        if (reto.fechaFin && new Date() > new Date(reto.fechaFin))
            return res.status(410).json({ error: 'Este reto ya expiró.' });

        // Verificar si ya participó
        const yaParticipó = reto.participantes.find(p => p.alumno === alumno);
        if (yaParticipó) return res.status(409).json({
            error: 'Ya completaste este reto.', pct: yaParticipó.pct, correctas: yaParticipó.correctas
        });

        // Calificar
        let correctas = 0;
        const detalles = reto.preguntas.map((q, i) => {
            const esCorrecta = respuestas[i] === q.r;
            if (esCorrecta) correctas++;
            return { esCorrecta, correcta: q.r, seleccionada: respuestas[i], pregunta: q.p };
        });
        const total = reto.preguntas.length;
        const pct   = Math.round((correctas / total) * 100);

        reto.participantes.push({ alumno, alumnoId: alumnoId || null, pct, correctas, total, tiempo: tiempoUsado || 0 });
        await reto.save();

        // Ranking actualizado
        const ranking = [...reto.participantes].sort((a,b) => b.pct-a.pct || a.tiempo-b.tiempo)
            .map((p,i) => ({ posicion: i+1, alumno: p.alumno, pct: p.pct }));
        const miPosicion = ranking.findIndex(r => r.alumno === alumno) + 1;

        res.json({ pct, correctas, total, miPosicion, totalParticipantes: reto.participantes.length, detalles });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resultados del reto para el maestro
app.get('/api/maestro/reto/:shortId/resultados', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const reto = await Reto.findOne({ shortId: req.params.shortId, maestroId: req.maestro.id }).lean();
        if (!reto) return res.status(404).json({ error: 'Reto no encontrado.' });

        const ranking = [...(reto.participantes||[])].sort((a,b) => b.pct-a.pct || a.tiempo-b.tiempo)
            .map((p,i) => ({ ...p, posicion: i+1 }));

        const prom = ranking.length ? Math.round(ranking.reduce((a,r)=>a+r.pct,0)/ranking.length) : 0;
        res.json({ reto: { ...reto, preguntas: undefined }, ranking, promedio: prom });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reto FULL para el maestro (incluye respuestas correctas) — usado para imprimir/PDF
app.get('/api/maestro/reto/:shortId/full', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const reto = await Reto.findOne({ shortId: req.params.shortId, maestroId: req.maestro.id }).lean();
        if (!reto) return res.status(404).json({ error: 'Reto no encontrado.' });
        res.json({
            shortId: reto.shortId,
            titulo: reto.titulo,
            descripcion: reto.descripcion,
            tiempoLimite: reto.tiempoLimite,
            fechaFin: reto.fechaFin,
            preguntas: (reto.preguntas || []).map(q => ({
                p: q.p || q.pregunta || '',
                pregunta: q.p || q.pregunta || '',
                o: q.o || q.opciones || [],
                opciones: q.o || q.opciones || [],
                r: typeof q.r === 'number' ? q.r : (typeof q.respuesta === 'number' ? q.respuesta : -1),
                bloom: q.bloom || '',
                fuente: q.fuente || '',
                explicacion: q.explicacion || ''
            }))
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cerrar reto
app.patch('/api/maestro/reto/:shortId/estado', verifyToken, async (req, res) => {
    try {
        const reto = await Reto.findOneAndUpdate(
            { shortId: req.params.shortId, maestroId: req.maestro.id },
            { activo: req.body.activo }, { new: true }
        );
        if (!reto) return res.status(404).json({ error: 'Reto no encontrado.' });
        res.json({ ok: true, activo: reto.activo });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ PLAN DE ESTUDIO — 3 lecturas → examen automático ══
// El maestro crea un "plan" con N tareas. Al completarlas todas, se genera el examen automáticamente.

const planEstudioSchema = new mongoose.Schema({
    shortId:       { type: String, unique: true, index: true },
    maestroId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Maestro', index: true },
    grupoId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Grupo', index: true },
    titulo:        String,
    descripcion:   String,
    objetivos:     [{ type: String }],   // Objetivos de aprendizaje (Bloom)
    competencias:  [{ type: String }],   // Competencias a desarrollar
    requisitosPrevios: { type: String, default: '' },
    rubricaEvaluacion: { type: String, default: '' },
    tipo:          { type: String, enum: ['plan','parcial','final'], default: 'plan' },
    tareaIds:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'Tarea' }],
    preguntasPorTarea: { type: Number, default: 5 },
    tiempoLimiteMin:   { type: Number, default: 45 },
    activo:        { type: Boolean, default: true },
    creadoEn:      { type: Date, default: Date.now, expires: 60*60*24*180 }
});
const PlanEstudio = mongoose.models.PlanEstudio || mongoose.model('PlanEstudio', planEstudioSchema);

// Crear plan de estudio
app.post('/api/maestro/plan-estudio', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { grupoId, tareaIds, titulo, descripcion, preguntasPorTarea, tiempoLimiteMin,
                objetivos, competencias, requisitosPrevios, rubricaEvaluacion, tipo } = req.body;
        if (!tareaIds?.length || tareaIds.length < 2)
            return res.status(400).json({ error: 'Selecciona al menos 2 tareas para el plan.' });

        const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        // Verificar que las tareas pertenecen al maestro
        const tareas = await Tarea.find({ _id: { $in: tareaIds }, maestroId: req.maestro.id }).select('titulo').lean();
        if (tareas.length !== tareaIds.length)
            return res.status(403).json({ error: 'Algunas tareas no te pertenecen.' });

        const shortId = await shortIdUnico(PlanEstudio);
        const plan = await PlanEstudio.create({
            shortId, maestroId: req.maestro.id, grupoId,
            titulo:   titulo || `Plan de Estudio — ${grupo.nombre}`,
            descripcion: descripcion || `Completa las ${tareas.length} lecturas para desbloquear el examen final.`,
            objetivos:    Array.isArray(objetivos)    ? objetivos.filter(Boolean).slice(0, 12) : [],
            competencias: Array.isArray(competencias) ? competencias.filter(Boolean).slice(0, 8) : [],
            requisitosPrevios: requisitosPrevios || '',
            rubricaEvaluacion: rubricaEvaluacion || '',
            tipo: ['plan','parcial','final'].includes(tipo) ? tipo : 'plan',
            tareaIds, preguntasPorTarea: preguntasPorTarea || 5,
            tiempoLimiteMin: tiempoLimiteMin || 45, activo: true
        });
        res.json({
            shortId: plan.shortId, titulo: plan.titulo,
            totalTareas: tareas.length,
            tareas: tareas.map(t => t.titulo)
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar planes del maestro
app.get('/api/maestro/planes-estudio', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const planes = await PlanEstudio.find({ maestroId: req.maestro.id })
            .sort({ creadoEn: -1 })
            .populate('tareaIds', 'titulo shortId')
            .lean();
        res.json({ planes });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ EXAMEN PARCIAL — multi-fuente (tareas + lecciones previas + links/textos) ══
// El maestro selecciona libremente qué tareas/lecciones del grupo + URLs externas + textos
// para que la IA genere un examen sintetizando TODO el contenido.
app.post('/api/maestro/examen-parcial', verifyToken, upload.array('archivos', 6), async (req, res) => {
    const archivos = req.files || [];
    const tmpPaths = archivos.map(f => f.path);
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        // Soportamos JSON y multipart. En multipart los arrays vienen como string o array según multer.
        const asArr = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);
        const grupoId         = req.body.grupoId;
        const titulo          = req.body.titulo;
        const instrucciones   = req.body.instrucciones;
        const tareaIds        = asArr(req.body.tareaIds);
        const lecciones       = asArr(req.body.lecciones);
        const urls            = asArr(req.body.urls);
        const textosExtra     = asArr(req.body.textosExtra);
        const numPreguntas    = parseInt(req.body.numPreguntas) || 20;
        const tiempoLimiteMin = parseInt(req.body.tiempoLimiteMin) || 60;

        const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado o no te pertenece.' });

        if (!tareaIds.length && !lecciones.length && !urls.length && !textosExtra.length && !archivos.length) {
            return res.status(400).json({ error: 'Agrega al menos una fuente (tarea, lección, link, texto o foto/PDF).' });
        }

        // 1. Acumular contexto de TODAS las fuentes
        let contextoCombinado = '';
        let fuentesUsadas = [];

        // Tareas del maestro
        if (tareaIds.length) {
            const tareas = await Tarea.find({ _id: { $in: tareaIds }, maestroId: req.maestro.id })
                .select('titulo resumen contexto').lean();
            for (const t of tareas) {
                contextoCombinado += `\n\n=== TAREA: ${t.titulo} ===\n${(t.resumen || '').replace(/<[^>]+>/g,' ').substring(0, 4000)}\n${(t.contexto || '').substring(0, 3000)}`;
                fuentesUsadas.push({ tipo: 'tarea', titulo: t.titulo });
            }
        }

        // Lecciones previas (Sesiones del grupo o Tareas referenciadas por shortId)
        if (lecciones.length) {
            const sesiones = await Sesion.find({ shortId: { $in: lecciones }, grupoId })
                .select('titulo resumen').lean();
            for (const s of sesiones) {
                contextoCombinado += `\n\n=== LECCIÓN PREVIA: ${s.titulo} ===\n${(s.resumen || '').replace(/<[^>]+>/g,' ').substring(0, 3500)}`;
                fuentesUsadas.push({ tipo: 'leccion', titulo: s.titulo });
            }
        }

        // Links externos: extraer texto
        for (const url of urls.slice(0, 5)) {
            try {
                const texto = await extraerTextoWeb(url);
                if (texto && texto.length > 100) {
                    contextoCombinado += `\n\n=== FUENTE EXTERNA (${url}) ===\n${texto.substring(0, 5000)}`;
                    fuentesUsadas.push({ tipo: 'url', url });
                }
            } catch(_){}
        }

        // Textos pegados
        for (const txt of textosExtra.slice(0, 5)) {
            if (txt && String(txt).length > 30) {
                contextoCombinado += `\n\n=== TEXTO ADICIONAL ===\n${String(txt).substring(0, 5000)}`;
                fuentesUsadas.push({ tipo: 'texto', titulo: 'Texto adicional' });
            }
        }

        // Archivos (imágenes / PDFs subidos por el profe)
        if (archivos.length) {
            for (const archivo of archivos.slice(0, 6)) {
                try {
                    const buf = await readFile(archivo.path);
                    const mime = archivo.mimetype || '';
                    let texto = '';
                    if (mime === 'application/pdf') {
                        try { texto = (await pdfParse(buf)).text || ''; } catch { texto = ''; }
                        // Si pdf-parse falló, fallback a Gemini Vision
                        if (texto.trim().length < 100) {
                            try { texto = await extractImageText(buf, mime); } catch {}
                        }
                    } else if (mime.startsWith('image/')) {
                        texto = await extractImageText(buf, mime);
                    } else {
                        texto = buf.toString('utf-8');
                    }
                    if (texto && texto.trim().length > 30) {
                        contextoCombinado += `\n\n=== ARCHIVO: ${archivo.originalname} ===\n${texto.substring(0, 6000)}`;
                        fuentesUsadas.push({ tipo: 'archivo', titulo: archivo.originalname });
                    }
                } catch(e) { console.warn('Archivo parcial falló:', e.message); }
            }
        }

        if (!contextoCombinado.trim()) {
            return res.status(400).json({ error: 'No se pudo extraer contenido de las fuentes proporcionadas.' });
        }

        // 2. Pedir a la IA que sintetice un examen NUEVO (no muestra de pools viejos)
        const N = Math.max(5, Math.min(50, Number(numPreguntas) || 20));
        const sistema = `Eres un profesor universitario mexicano de élite especializado en evaluación auténtica. Generas exámenes parciales de altísima calidad que sintetizan información de MÚLTIPLES fuentes simultáneamente. Las preguntas no son de memorización plana sino que exigen integrar conceptos entre fuentes. Distractores plausibles que reflejen errores reales de aula. Respondes ÚNICAMENTE con JSON válido.`;

        const usuario = `Genera un examen parcial para alumnos de "${grupo.materia} — ${grupo.semestre}" con EXACTAMENTE ${N} preguntas integradoras a partir del material acumulado abajo (${fuentesUsadas.length} fuentes).

REGLAS DE CALIDAD:
- Las preguntas DEBEN integrar contenido de varias fuentes — no preguntar solo sobre una.
- Distribución Bloom recomendada: ~20% recordar/comprender, ~40% aplicar/analizar, ~40% evaluar/crear (a menos que se indique otra).
- 4 opciones por pregunta, 3 distractores plausibles (errores reales de estudiante), longitud similar (±20%).
- NO uses "ninguna/todas las anteriores".
- Cada pregunta DEBE incluir "explicacion" didáctica de 2-3 frases.
- Cada pregunta debe llevar un campo "fuente" indicando qué tema/fuente cubre.
- NO inventes datos específicos no presentes en el material; si los necesitas, cuéntalos como "según el material".

FORMATO JSON:
{
  "titulo": "Examen parcial: [tema integrador]",
  "preguntas": [
    {"p":"...","o":["A","B","C","D"],"r":0,"bloom":"aplicar","explicacion":"...","fuente":"Tarea: ..."}
  ]
}

CONTENIDO ACUMULADO (todas las fuentes):
${contextoCombinado.substring(0, 38000)}`;

        const text = await iaCall([
            { role: 'system', content: sistema },
            { role: 'user',   content: usuario }
        ], true, { tipo: 'examen-parcial' });

        let data;
        try {
            const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
            data = JSON.parse(clean);
        } catch(e) {
            const m = text.match(/\{[\s\S]+\}/);
            if (m) data = JSON.parse(m[0]); else throw new Error('La IA no devolvió JSON válido.');
        }

        let preguntas = normalizeQuestions(data.preguntas || []).slice(0, N);
        if (preguntas.length < 5) {
            return res.status(502).json({ error: `La IA solo devolvió ${preguntas.length} preguntas válidas. Reintenta o agrega más fuentes.` });
        }

        const shortId = await shortIdUnico(Examen);
        const examen = await Examen.create({
            shortId,
            maestroId: req.maestro.id,
            grupoId,
            titulo: titulo || data.titulo || `Examen parcial — ${grupo.nombre}`,
            instrucciones: instrucciones || `Examen parcial sintetizado desde ${fuentesUsadas.length} fuente(s). Tienes ${tiempoLimiteMin} minutos.`,
            preguntas, tiempoLimite: tiempoLimiteMin, activo: true
        });

        res.json({
            shortId: examen.shortId,
            titulo: examen.titulo,
            totalPreguntas: preguntas.length,
            fuentes: fuentesUsadas
        });
    } catch(e) {
        console.error('examen-parcial error:', e);
        res.status(500).json({ error: e.message });
    } finally {
        // Limpiar archivos temporales
        for (const p of tmpPaths) {
            try { await import('fs/promises').then(fs => fs.unlink(p)); } catch {}
        }
    }
});

// Sugerir objetivos de aprendizaje a partir de las tareas del plan (IA)
app.post('/api/maestro/plan-estudio/sugerir-objetivos', verifyToken, async (req, res) => {
    try {
        const { tareaIds = [], grupoId } = req.body;
        if (!tareaIds.length) return res.status(400).json({ error: 'Selecciona al menos una tarea.' });
        const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });
        const tareas = await Tarea.find({ _id: { $in: tareaIds }, maestroId: req.maestro.id })
            .select('titulo abstract').lean();
        const sumario = tareas.map((t,i) => `${i+1}. ${t.titulo} — ${t.abstract||''}`).join('\n');
        const sistema = `Eres un diseñador instruccional experto en taxonomía de Bloom revisada. Generas objetivos de aprendizaje específicos, medibles y alineados a Bloom. Respondes JSON.`;
        const usuario = `Para "${grupo.materia} — ${grupo.semestre}" basado en estas tareas:
${sumario}

Genera objetivos de aprendizaje y competencias. JSON:
{
  "objetivos": ["Al finalizar, el alumno será capaz de [verbo Bloom] [contenido] [contexto/condición]", ...8 objetivos máx],
  "competencias": ["Pensamiento crítico aplicado a...", ...5 máx],
  "requisitosPrevios": "1 párrafo describiendo qué debe saber antes",
  "rubricaEvaluacion": "1 párrafo con criterios de evaluación general"
}`;
        const text = await iaCall([
            { role:'system', content: sistema },
            { role:'user',   content: usuario }
        ], true, { tipo:'sugerir-objetivos' });
        let data;
        try { data = JSON.parse(text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()); }
        catch(_) { const m = text.match(/\{[\s\S]+\}/); data = m ? JSON.parse(m[0]) : {}; }
        res.json({
            objetivos: Array.isArray(data.objetivos) ? data.objetivos.slice(0,8) : [],
            competencias: Array.isArray(data.competencias) ? data.competencias.slice(0,5) : [],
            requisitosPrevios: data.requisitosPrevios || '',
            rubricaEvaluacion: data.rubricaEvaluacion || ''
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Alumno: consultar su progreso en un plan y si puede tomar el examen
app.get('/api/plan-estudio/:shortId/progreso', verifyAlumno, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const plan = await PlanEstudio.findOne({ shortId: req.params.shortId, activo: true })
            .populate('tareaIds', 'titulo shortId abstract')
            .lean();
        if (!plan) return res.status(404).json({ error: 'Plan no encontrado.' });

        const alumno = await Alumno.findById(req.alumno.id).select('nombre').lean();
        const nombre = alumno?.nombre || '';

        // Verificar qué tareas completó el alumno
        const progresos = await Promise.all(plan.tareaIds.map(async (tarea) => {
            const sesion = await Sesion.findOne({
                nombre: { $regex: new RegExp(`^${nombre}$`, 'i') },
                tareaId: tarea._id
            }).select('pct shortId creadoEn').lean();
            return {
                tarea: { _id: tarea._id, titulo: tarea.titulo, shortId: tarea.shortId, abstract: tarea.abstract },
                completada: !!sesion,
                pct: sesion?.pct || null,
                sesionShortId: sesion?.shortId || null
            };
        }));

        const completadas = progresos.filter(p => p.completada).length;
        const totalTareas = progresos.length;
        const listoParaExamen = completadas === totalTareas;
        const pctProgreso = Math.round((completadas / totalTareas) * 100);

        // Verificar si ya tiene examen generado para este plan
        let examenExistente = null;
        if (listoParaExamen) {
            examenExistente = await Examen.findOne({
                grupoId: plan.grupoId,
                titulo: { $regex: plan.titulo }
            }).select('shortId titulo activo').lean();
        }

        res.json({
            plan: { titulo: plan.titulo, descripcion: plan.descripcion },
            progresos, completadas, totalTareas, pctProgreso,
            listoParaExamen, examenExistente
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Generar examen automático cuando el alumno completa el plan
app.post('/api/plan-estudio/:shortId/generar-examen', verifyAlumno, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const plan = await PlanEstudio.findOne({ shortId: req.params.shortId, activo: true })
            .populate('tareaIds', 'titulo poolPreguntas')
            .lean();
        if (!plan) return res.status(404).json({ error: 'Plan no encontrado.' });

        const alumno = await Alumno.findById(req.alumno.id).select('nombre').lean();
        const nombre = alumno?.nombre || '';

        // Verificar que completó todas las tareas
        const completadas = await Promise.all(plan.tareaIds.map(t =>
            Sesion.findOne({ nombre: { $regex: new RegExp(`^${nombre}$`,'i') }, tareaId: t._id }).lean()
        ));
        if (completadas.some(c => !c))
            return res.status(403).json({ error: 'Debes completar todas las lecturas primero.' });

        // Revisar si ya existe examen para este alumno en este plan
        const examenKey = `plan_${plan.shortId}_${req.alumno.id}`;
        const existente = await Examen.findOne({ shortId: { $regex: examenKey.substring(0,8) } }).lean();
        if (existente) return res.json({ examenShortId: existente.shortId, yaExistia: true });

        // Combinar preguntas de todas las tareas
        let preguntas = [];
        plan.tareaIds.forEach(t => {
            const pool = t.poolPreguntas || [];
            const ppt  = plan.preguntasPorTarea || 5;
            preguntas.push(...pool.sort(() => Math.random()-0.5).slice(0, ppt));
        });
        preguntas = preguntas.sort(() => Math.random()-0.5);

        const shortId = await shortIdUnico(Examen);
        const examen = await Examen.create({
            shortId,
            maestroId: plan.maestroId,
            grupoId:   plan.grupoId,
            titulo:    `Examen: ${plan.titulo}`,
            instrucciones: `Examen final del plan "${plan.titulo}". Tienes ${plan.tiempoLimiteMin} minutos.`,
            preguntas, tiempoLimite: plan.tiempoLimiteMin, activo: true
        });

        // Desbloquear logro "primer_examen" si aplica
        try {
            await verificarLogros(req.alumno.id, { totalSesiones: completadas.length, primer_examen: true });
        } catch {}

        res.json({ examenShortId: examen.shortId, titulo: examen.titulo, totalPreguntas: preguntas.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Tutor IA en puerto ${PORT} — motor: ${GEMINI_KEY ? 'Gemini 2.5 Flash' : 'GROQ'}`));
