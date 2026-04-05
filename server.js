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

// ── Modelos de IA disponibles
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GROQ_KEY    = process.env.GROQ_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash-preview-05-14'; // mejor calidad
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

if (!GEMINI_KEY && !GROQ_KEY) console.error("⚠️  FALTA GEMINI_API_KEY o GROQ_API_KEY");
if (!process.env.MONGODB_URI) console.warn("⚠️  FALTA MONGODB_URI");
console.log(`🤖 Motor IA: ${GEMINI_KEY ? 'Gemini 2.5 Flash' : 'GROQ llama-3.3-70b'}`);


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
    escuelaId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Escuela', index: true, default: null },
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
    activo:      { type: Boolean, default: true },
    creadoEn:    { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 }
});
const Examen = mongoose.models.Examen || mongoose.model('Examen', examenSchema);

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
    nombre:       { type: String, required: true },
    email:        { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    escuelaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Escuela', index: true },
    creadoEn:     { type: Date, default: Date.now }
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
            const totalMaestros = await Maestro.countDocuments({ escuelaId: e._id });
            return { ...e, totalMaestros };
        }));
        res.json({ escuelas: enriquecidas });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/director', verifyAdmin, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { nombre, email, password, escuelaId } = req.body;
        if (!nombre || !email || !password || !escuelaId) return res.status(400).json({ error: 'Faltan campos.' });
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

app.post('/api/director/login', async (req, res) => {
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
app.post('/api/alumno/login', async (req, res) => {
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
async function iaCall(messages, jsonMode = false, meta = {}) {
    // Intentar Gemini 2.5 Flash primero
    if (GEMINI_KEY) {
        try {
            return await geminiCall(messages, jsonMode, meta);
        } catch(e) {
            console.warn('Gemini falló, usando GROQ fallback:', e.message);
        }
    }
    // Fallback GROQ
    return await iaCall(messages, jsonMode, meta);
}

async function geminiCall(messages, jsonMode = false, meta = {}) {
    // Convertir formato OpenAI → Gemini
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs  = messages.filter(m => m.role !== 'system');

    const contents = userMsgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(m.content)
            ? m.content.map(c => c.type === 'image_url'
                ? { inlineData: { mimeType: c.image_url.url.split(';')[0].split(':')[1], data: c.image_url.url.split(',')[1] } }
                : { text: c.text || '' })
            : [{ text: m.content }]
    }));

    const body = {
        contents,
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 8192,
            ...(jsonMode ? { responseMimeType: 'application/json' } : {})
        }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
    });

    const candidate = response.data.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text).join('') || '';
    if (!text) throw new Error('Gemini retornó respuesta vacía');

    // Registrar uso
    const usage = response.data.usageMetadata || {};
    const tokensInput  = usage.promptTokenCount     || 0;
    const tokensOutput = usage.candidatesTokenCount || 0;
    const costoUSD = (tokensInput * 0.000000075) + (tokensOutput * 0.0000003); // Gemini 2.5 Flash
    if (mongoose.connection.readyState) {
        UsageLog.create({
            escuelaId: meta.escuelaId || null,
            maestroId: meta.maestroId || null,
            tipo: meta.tipo || 'estudiar',
            modelo: GEMINI_MODEL,
            tokensInput, tokensOutput, tokensTotal: tokensInput + tokensOutput, costoUSD
        }).catch(() => {});
    }
    return text;
}

async function groqCall(messages, jsonMode = false, meta = {}) {
    const body = { model: GROQ_MODEL, messages, temperature: 0.7, max_tokens: 4096 };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions', body,
        { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const usage = response.data.usage || {};
    const tokensInput  = usage.prompt_tokens    || 0;
    const tokensOutput = usage.completion_tokens || 0;
    const costoUSD = (tokensInput * 0.00000059) + (tokensOutput * 0.00000079);
    if (mongoose.connection.readyState) {
        UsageLog.create({
            escuelaId: meta.escuelaId || null, maestroId: meta.maestroId || null,
            tipo: meta.tipo || 'estudiar', modelo: GROQ_MODEL,
            tokensInput, tokensOutput, tokensTotal: tokensInput + tokensOutput, costoUSD
        }).catch(() => {});
    }
    return response.data.choices[0].message.content;
}

const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

// ══ EXTRACCIÓN WEB MEJORADA ══

// Detectar si es YouTube y extraer transcript/info
function esYoutube(url) {
    return /youtube\.com|youtu\.be/.test(url);
}
function extraerYoutubeId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

async function extraerTextoYoutube(url) {
    const videoId = extraerYoutubeId(url);
    if (!videoId) throw new Error('No se pudo identificar el video de YouTube.');

    // Intentar obtener transcript via API de terceros (gratuita)
    try {
        const transcriptRes = await axios.get(
            `https://yt-transcript-api.vercel.app/api/transcript?videoId=${videoId}&lang=es`,
            { timeout: 10000 }
        ).catch(() => null);

        if (transcriptRes?.data?.transcript?.length) {
            const texto = transcriptRes.data.transcript.map(t => t.text).join(' ');
            return { texto, videoId, esVideo: true };
        }
    } catch {}

    // Fallback: obtener título y descripción via oEmbed
    try {
        const oEmbed = await axios.get(
            `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
            { timeout: 8000 }
        );
        const titulo = oEmbed.data.title || 'Video de YouTube';
        const autor  = oEmbed.data.author_name || '';
        return {
            texto: `Video de YouTube: "${titulo}" por ${autor}. Este es un video educativo sobre el tema mencionado en el título.`,
            videoId, esVideo: true, titulo, autor
        };
    } catch {}

    return { texto: `Video de YouTube (ID: ${videoId}). Genera contenido educativo basado en el tema del video.`, videoId, esVideo: true };
}

async function extraerTextoWeb(url) {
    // YouTube: manejo especial
    if (esYoutube(url)) {
        const result = await extraerTextoYoutube(url);
        return result; // retorna objeto {texto, videoId, esVideo}
    }

    // 1. Intentar Jina.ai Reader — bypass de paywalls y JS rendering
    try {
        const jinaRes = await axios.get(`https://r.jina.ai/${url}`, {
            timeout: 20000,
            headers: {
                'Accept': 'text/plain',
                'X-Return-Format': 'text',
                'X-Timeout': '15'
            }
        });
        if (jinaRes.data && jinaRes.data.length > 300) {
            // Limpiar el texto de Jina
            const texto = jinaRes.data
                .replace(/^Title:.*\n/m, '')
                .replace(/^URL Source:.*\n/m, '')
                .replace(/^Markdown Content:/m, '')
                .replace(/!\[.*?\]\(.*?\)/g, '') // imágenes markdown
                .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // links markdown → solo texto
                .replace(/#{1,6}\s/g, '') // headers
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            if (texto.length > 300) return texto;
        }
    } catch(e) {
        console.log('Jina.ai falló, intentando scraping directo:', e.message);
    }

    // 2. Scraping directo como fallback
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer', timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
            }
        });
        const ct = response.headers['content-type'] || '';
        if (ct.includes('application/pdf')) return (await pdfParse(response.data)).text;
        if (ct.includes('text/html')) {
            const $ = cheerio.load(response.data.toString('utf-8'));
            $('script,style,nav,footer,aside,header,iframe,noscript,.ad,.ads,.advertisement,.sidebar,.menu,.navbar,.cookie,.popup,.modal,form,button').remove();
            const mainContent = $('article, main, .content, .post, .entry, #content, #main, .article-body, [role=main]').text();
            if (mainContent.trim().length > 200) return mainContent.replace(/\s+/g,' ').trim();
            return $('h1,h2,h3,h4,p,li,td,th,blockquote').text().replace(/\s+/g,' ').trim();
        }
        return response.data.toString('utf-8').substring(0, 20000);
    } catch(e) {
        // 3. Último fallback — Wayback Machine
        try {
            const wbRes = await axios.get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeout: 8000 });
            const snap = wbRes.data?.archived_snapshots?.closest;
            if (snap?.url) {
                const archiveRes = await axios.get(snap.url, { timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0' } });
                const $ = cheerio.load(archiveRes.data);
                $('script,style,nav,footer').remove();
                return $('p,h1,h2,h3,li').text().replace(/\s+/g,' ').trim().substring(0, 20000);
            }
        } catch {}
        throw new Error("No se pudo acceder al contenido. Intenta copiar y pegar el texto directamente.");
    }
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
            content: `Eres un profesor de preparatoria mexicano experto y apasionado. Tu misión es transformar cualquier contenido en una experiencia de aprendizaje memorable. Respondes ÚNICAMENTE con JSON válido y bien formado, sin texto adicional ni bloques de código.`
        },
        {
            role: 'user',
            content: `Fuente: ${contextoTipo}

Transforma el siguiente contenido en una clase magistral completa y atractiva para estudiantes de preparatoria (14-18 años) en México.

INSTRUCCIONES DETALLADAS:
1. RESUMEN (clase magistral): Mínimo 6 párrafos ricos y detallados. Escribe como un maestro apasionado que explica con ejemplos concretos, analogías y contexto cultural mexicano cuando aplique. Usa <b>negritas</b> para conceptos clave y <br><br> entre párrafos. NUNCA uses viñetas ni listas — siempre prosa fluida.
2. PODCAST: Texto pensado para leerlo en voz alta, natural y conversacional, como si hablaras directamente al estudiante. Usa "imagina que..." y "piénsalo así...". Entre 300-400 palabras.
3. QUIZ: 6 preguntas que van de fácil a difícil. Las preguntas deben evaluar comprensión real, no memorización. Las 4 opciones deben ser plausibles (no tramposamente obvias). El índice de respuesta correcta (r) empieza en 0.
4. FLASHCARDS: 8 tarjetas con los conceptos más importantes. El reverso debe incluir: definición clara + ejemplo práctico + por qué importa.

FORMATO JSON (SOLO JSON, sin markdown ni texto extra):
{
  "titulo": "Título atractivo y específico del tema",
  "resumen": "Clase magistral rica con <b>conceptos</b> en negritas y <br><br> entre párrafos...",
  "podcast": "Texto conversacional para escuchar...",
  "quiz": [
    {"p": "Pregunta clara y específica", "o": ["Opción completa A", "Opción completa B", "Opción completa C", "Opción completa D"], "r": 0},
    {"p": "Pregunta más elaborada", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2},
    {"p": "Pregunta de aplicación", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 1},
    {"p": "Pregunta de análisis", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 3},
    {"p": "Pregunta que conecta conceptos", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 0},
    {"p": "Pregunta de nivel avanzado", "o": ["Opción A", "Opción B", "Opción C", "Opción D"], "r": 2}
  ],
  "flashcards": [
    {"anverso": "Término o concepto", "reverso": "Definición precisa. Ejemplo: [ejemplo concreto]. Importancia: [por qué esto importa]."},
    {"anverso": "Término 2", "reverso": "Definición + ejemplo + importancia."},
    {"anverso": "Término 3", "reverso": "Definición + ejemplo + importancia."},
    {"anverso": "Término 4", "reverso": "Definición + ejemplo + importancia."},
    {"anverso": "Término 5", "reverso": "Definición + ejemplo + importancia."},
    {"anverso": "Término 6", "reverso": "Definición + ejemplo + importancia."},
    {"anverso": "Término 7", "reverso": "Definición + ejemplo + importancia."},
    {"anverso": "Término 8", "reverso": "Definición + ejemplo + importancia."}
  ]${esVideo ? ',\n  "videoId": "' + videoId + '"' : ''}
}

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
    if (videoId) data.videoId = videoId;
    return data;
}

// ── Procesador IA para Tarea — genera pool de 15 preguntas + abstract
async function procesarConIAPool(sourceText, meta = {}) {
    if (!sourceText || sourceText.length < 50)
        throw new Error("No se encontró suficiente texto para analizar.");

    const messages = [
        {
            role: 'system',
            content: 'Eres un profesor de preparatoria mexicano experto. Creas material de estudio de altísima calidad. Respondes ÚNICAMENTE con JSON válido y bien formado, sin texto adicional ni bloques de código markdown.'
        },
        {
            role: 'user',
            content: `Crea material completo de estudio para preparatoria basándote en el siguiente contenido.

INSTRUCCIONES:
1. RESUMEN: Mínimo 6 párrafos como clase magistral. Maestro apasionado, ejemplos concretos, contexto real. Usa <b>negritas</b> para conceptos clave y <br><br> entre párrafos. Sin viñetas ni listas.
2. ABSTRACT: 2-3 oraciones que enganchen al alumno: "En esta clase aprenderás... y por qué importa en tu vida."
3. PODCAST: Guión conversacional para escuchar (300-400 palabras). Habla directo al alumno, usa analogías cotidianas.
4. POOL DE PREGUNTAS (15): Distribuye la dificultad — 5 básicas (nivel recordar/comprender), 5 intermedias (aplicar/analizar), 5 avanzadas (evaluar/crear). Las 4 opciones deben ser específicas y plausibles. NUNCA uses letras como opciones.
5. FLASHCARDS (8): Término → Definición precisa + ejemplo real + por qué importa conocerlo.

FORMATO JSON REQUERIDO:
{
  "titulo": "Título atractivo y específico",
  "abstract": "2-3 oraciones que enganchen: qué aprenderás y por qué importa.",
  "resumen": "Clase magistral con <b>conceptos</b> en negritas y <br><br> entre párrafos...",
  "podcast": "Guión conversacional para escuchar...",
  "poolPreguntas": [
    {"p": "¿Pregunta básica sobre el tema?", "o": ["Respuesta correcta", "Distractor plausible 1", "Distractor plausible 2", "Distractor plausible 3"], "r": 0},
    {"p": "¿Pregunta de comprensión?", "o": ["Distractor", "Respuesta correcta", "Distractor", "Distractor"], "r": 1},
    {"p": "¿Pregunta de aplicación?", "o": ["Distractor", "Distractor", "Respuesta correcta", "Distractor"], "r": 2},
    {"p": "¿Pregunta de análisis?", "o": ["Distractor", "Distractor", "Distractor", "Respuesta correcta"], "r": 3},
    {"p": "¿Quinta pregunta?", "o": ["Respuesta correcta", "Distractor", "Distractor", "Distractor"], "r": 0},
    {"p": "¿Sexta pregunta?", "o": ["Distractor", "Respuesta correcta", "Distractor", "Distractor"], "r": 1},
    {"p": "¿Séptima pregunta?", "o": ["Distractor", "Distractor", "Respuesta correcta", "Distractor"], "r": 2},
    {"p": "¿Octava pregunta?", "o": ["Distractor", "Distractor", "Distractor", "Respuesta correcta"], "r": 3},
    {"p": "¿Novena pregunta?", "o": ["Respuesta correcta", "Distractor", "Distractor", "Distractor"], "r": 0},
    {"p": "¿Décima pregunta?", "o": ["Distractor", "Respuesta correcta", "Distractor", "Distractor"], "r": 1},
    {"p": "¿Pregunta avanzada 1?", "o": ["Distractor", "Distractor", "Respuesta correcta", "Distractor"], "r": 2},
    {"p": "¿Pregunta avanzada 2?", "o": ["Distractor", "Distractor", "Distractor", "Respuesta correcta"], "r": 3},
    {"p": "¿Pregunta avanzada 3?", "o": ["Respuesta correcta", "Distractor", "Distractor", "Distractor"], "r": 0},
    {"p": "¿Pregunta avanzada 4?", "o": ["Distractor", "Respuesta correcta", "Distractor", "Distractor"], "r": 1},
    {"p": "¿Pregunta más difícil?", "o": ["Distractor", "Distractor", "Respuesta correcta", "Distractor"], "r": 2}
  ],
  "flashcards": [
    {"anverso": "Término 1", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 2", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 3", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 4", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 5", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 6", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 7", "reverso": "Definición. Ejemplo: ... Importancia: ..."},
    {"anverso": "Término 8", "reverso": "Definición. Ejemplo: ... Importancia: ..."}
  ]
}

CONTENIDO FUENTE:
${sourceText.substring(0, 30000)}`
        }
    ];

    const text = await iaCall(messages, true, { ...meta, tipo: 'tarea' });
    try {
        const clean = text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        return JSON.parse(clean);
    } catch(e) {
        const jsonMatch = text.match(/\{[\s\S]+\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
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
app.post('/api/estudiar', verifyAlumno, checkLimiteDiario, async (req, res) => {
    try {
        const { input } = req.body;
        if (!input) return res.status(400).json({ error: "Falta contenido." });
        const meta = { alumnoId: req.alumno?.id };
        let fuente = input.trim();
        // extraerTextoWeb retorna string o {texto, videoId, esVideo} para YouTube
        if (fuente.startsWith('http')) fuente = await extraerTextoWeb(fuente);
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
app.post('/api/chat', async (req, res) => {
    try {
        const { context, question, sesionData, historial } = req.body;
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
app.post('/api/maestro/chat', verifyToken, async (req, res) => {
    try {
        const { grupoId, pregunta, historial } = req.body;
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });

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

// ══ CHAT DIRECTOR — SOLO datos reales de la institución ══
app.post('/api/director/chat', verifyDirector, async (req, res) => {
    try {
        const { pregunta, historial } = req.body;
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });

        let contextoInst = 'Sin datos disponibles.';
        if (mongoose.connection.readyState) {
            const hace30 = new Date(Date.now()-30*24*60*60*1000);
            const hace7  = new Date(Date.now()-7*24*60*60*1000);
            const hoyD   = new Date(new Date().setHours(0,0,0,0));

            const [totMaestros, totAlumnos, ses30, ses7, sesToday] = await Promise.all([
                Maestro.countDocuments(),
                Alumno.countDocuments({activo:true}),
                Sesion.countDocuments({creadoEn:{$gte:hace30}}),
                Sesion.countDocuments({creadoEn:{$gte:hace7}}),
                Sesion.countDocuments({creadoEn:{$gte:hoyD}})
            ]);

            const muestra = await Sesion.find({creadoEn:{$gte:hace30}}).select('pct nombre creadoEn').lean().limit(500);
            const prom = muestra.length ? Math.round(muestra.reduce((a,s)=>a+(s.pct||0),0)/muestra.length) : 0;

            // Alumnos en riesgo
            const alumMap = {};
            muestra.forEach(s=>{ if(!alumMap[s.nombre]) alumMap[s.nombre]=[]; alumMap[s.nombre].push(s.pct||0); });
            const riesgo = Object.entries(alumMap)
                .filter(([,ps])=>ps.length>=2 && ps.reduce((a,b)=>a+b,0)/ps.length < 60)
                .map(([n,ps])=>`${n} (${Math.round(ps.reduce((a,b)=>a+b,0)/ps.length)}%)`);

            const grupos = await Grupo.find({}).select('nombre semestre materia').lean();

            contextoInst = `DATOS INSTITUCIÓN (30 días):
• Maestros: ${totMaestros}, Alumnos activos: ${totAlumnos}
• Sesiones: hoy=${sesToday}, semana=${ses7}, mes=${ses30}
• Promedio institucional: ${prom}%
• Alumnos en riesgo (<60%): ${riesgo.length} — ${riesgo.slice(0,8).join(', ')||'ninguno'}
• Grupos activos: ${grupos.map(g=>`${g.nombre}(${g.materia})`).join(', ')||'ninguno'}`;
        }

        const histMsgs = (historial||[]).slice(-8).map(m=>({ role: m.role==='director'?'user':'assistant', content: m.texto }));

        const messages = [
            { role: 'system', content: `Eres un asistente estratégico para directores educativos. Analizas ÚNICAMENTE los datos reales de la institución.

REGLAS ESTRICTAS:
- SOLO usa los datos proporcionados. NUNCA inventes métricas o alumnos.
- Si no hay datos suficientes para responder, dilo claramente
- Respuestas ejecutivas: directas, con datos, sin relleno
- Máximo 5 puntos o 3 párrafos concisos
- Si preguntan algo fuera del ámbito institucional-educativo, declina

DATOS REALES:
${contextoInst}` },
            ...histMsgs,
            { role: 'user', content: pregunta }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat' });
        res.json({ answer });
    } catch(e) { res.status(500).json({ error: e.message }); }
});
    try {
        const { context, question, sesionData, historial } = req.body;
        if (!question) return res.status(400).json({ error: 'Falta la pregunta.' });

        // Construir contexto rico: resumen + flashcards + quiz
        let contextoCompleto = context || '';
        if (sesionData) {
            const { titulo, resumen, flashcards, quiz, podcast } = sesionData;
            contextoCompleto = `
TEMA DE LA CLASE: ${titulo || ''}

RESUMEN DE LA CLASE:
${(resumen || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}

${flashcards?.length ? `CONCEPTOS CLAVE:
${flashcards.map(f => `• ${f.anverso}: ${f.reverso || f.definicion || ''}`).join('\n')}` : ''}

${quiz?.length ? `PREGUNTAS DEL QUIZ (para referencia):
${quiz.map((q, i) => `${i+1}. ${q.p} → Respuesta: ${q.o?.[q.r] || ''}`).join('\n')}` : ''}

${podcast ? `GUIÓN DEL PODCAST:\n${podcast.substring(0, 1000)}` : ''}`.trim();
        }

        // Historial multi-turno
        const mensajesHistorial = (historial || []).slice(-10).map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.texto
        }));

        const messages = [
            {
                role: 'system',
                content: `Eres un tutor inteligente y amable para estudiantes de preparatoria mexicana. Tienes acceso completo al material de la clase que el alumno acaba de estudiar.

REGLAS IMPORTANTES:
- Responde SIEMPRE en español, de forma clara y motivadora
- Usa el contenido de la clase para dar respuestas precisas y específicas
- Si la pregunta es sobre algo en la clase, cita el contenido exacto
- Si el alumno no entendió algo, explícalo con una analogía diferente
- Máximo 3-4 párrafos por respuesta — conciso y claro
- NUNCA respondas sobre temas no educativos, violencia, política o contenido inapropiado
- Usa emojis con moderación para hacer la respuesta más visual
- Si el alumno se equivocó en algo, corrígelo con amabilidad

${contextoCompleto ? `\n=== MATERIAL DE LA CLASE ===\n${contextoCompleto}\n=== FIN DEL MATERIAL ===` : ''}`
            },
            ...mensajesHistorial,
            { role: 'user', content: question }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat' });
        res.json({ answer });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ CHAT DIRECTOR — con contexto de toda la institución ══
app.post('/api/director/chat', verifyDirector, async (req, res) => {
    try {
        const { pregunta, historial } = req.body;
        if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });

        let contextoInstitucion = '';
        if (mongoose.connection.readyState) {
            const grupoIds = await Grupo.find({}).select('_id');
            const ids = grupoIds.map(g => g._id);
            const hace30 = new Date(Date.now() - 30*24*60*60*1000);
            const hace7  = new Date(Date.now() - 7*24*60*60*1000);
            const hoy    = new Date(new Date().setHours(0,0,0,0));

            const [totalMaestros, totalAlumnos, sesiones30d, sesiones7d, sesionesHoy] = await Promise.all([
                Maestro.countDocuments(),
                Alumno.countDocuments({ activo: true }),
                Sesion.countDocuments({ creadoEn: { $gte: hace30 } }),
                Sesion.countDocuments({ creadoEn: { $gte: hace7 } }),
                Sesion.countDocuments({ creadoEn: { $gte: hoy } })
            ]);

            // Promedio general
            const sesionesMuestra = await Sesion.find({ creadoEn: { $gte: hace30 } }).select('pct nombre grupoId').lean().limit(500);
            const promedio = sesionesMuestra.length ? Math.round(sesionesMuestra.reduce((a,s)=>a+(s.pct||0),0)/sesionesMuestra.length) : 0;

            // Alumnos en riesgo (menos de 60% en últimas 3 sesiones)
            const alumnosRiesgo = [];
            const alumnosMap = {};
            sesionesMuestra.forEach(s => {
                if (!alumnosMap[s.nombre]) alumnosMap[s.nombre] = [];
                alumnosMap[s.nombre].push(s.pct || 0);
            });
            Object.entries(alumnosMap).forEach(([nombre, pcts]) => {
                const ultimas3 = pcts.slice(-3);
                const prom3 = ultimas3.reduce((a,b)=>a+b,0)/ultimas3.length;
                if (prom3 < 60 && ultimas3.length >= 2) alumnosRiesgo.push({ nombre, prom: Math.round(prom3) });
            });

            const grupos = await Grupo.find({}).populate('maestroId', 'nombre').select('nombre semestre materia').lean();

            contextoInstitucion = `
DATOS DE LA INSTITUCIÓN (últimos 30 días):
- Maestros activos: ${totalMaestros}
- Alumnos activos: ${totalAlumnos}
- Sesiones hoy: ${sesionesHoy}
- Sesiones esta semana: ${sesiones7d}
- Sesiones este mes: ${sesiones30d}
- Promedio general de la institución: ${promedio}%
- Alumnos en riesgo académico (<60%): ${alumnosRiesgo.length}
${alumnosRiesgo.length ? `\nALUMNOS EN RIESGO:\n${alumnosRiesgo.map(a=>`  - ${a.nombre}: ${a.prom}%`).slice(0,10).join('\n')}` : ''}

GRUPOS ACTIVOS:
${grupos.map(g=>`- ${g.nombre} | ${g.materia} | ${g.semestre}`).join('\n')}`;
        }

        const mensajesHistorial = (historial||[]).slice(-8).map(m => ({
            role: m.role === 'director' ? 'user' : 'assistant',
            content: m.texto
        }));

        const messages = [
            {
                role: 'system',
                content: `Eres un asistente estratégico para directores de instituciones educativas. Analizas datos de desempeño institucional y das recomendaciones ejecutivas, concretas y accionables.

ESTILO:
- Respuestas ejecutivas: directas, con datos, sin relleno
- Usa métricas reales cuando las tengas
- Si hay problemas, propón soluciones concretas con pasos
- Máximo 4-5 puntos o 2-3 párrafos cortos
- Habla de "tu institución", "tus alumnos", "tu equipo"

${contextoInstitucion ? `\nDATOS ACTUALES DE LA INSTITUCIÓN:\n${contextoInstitucion}` : ''}`
            },
            ...mensajesHistorial,
            { role: 'user', content: pregunta }
        ];

        const answer = await iaCall(messages, false, { tipo: 'chat' });
        res.json({ answer });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
        let tareasAsignadas = [], tareasCompletadas = [];
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

        const answer = await iaCall(messages);
        res.json({ answer });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ BÚSQUEDA DE RECURSOS EDUCATIVOS DE CALIDAD ══
app.post('/api/maestro/recursos', verifyToken, async (req, res) => {
    try {
        const { tema } = req.body;
        if (!tema || tema.length < 3) return res.status(400).json({ error: 'Escribe un tema para buscar.' });

        // ── Paso 1: IA genera sugerencias con URLs candidatas
        const promptSugerencias = `Eres un experto en recursos educativos digitales para preparatoria en México.
Un maestro necesita materiales de ALTA CALIDAD sobre: "${tema}".

REGLAS CRÍTICAS PARA URLS:
- Solo fuentes que existen con certeza absoluta
- Wikipedia en español: SIEMPRE usa el formato https://es.wikipedia.org/wiki/TITULO_CON_GUIONES_BAJOS
- Khan Academy: https://es.khanacademy.org/SECCION/TEMA (solo si sabes la URL exacta)
- YouTube: https://www.youtube.com/results?search_query=TEMA+educativo (búsqueda, no video específico)
- Para cualquier otro sitio: SOLO la homepage si no conoces el artículo exacto
- NUNCA inventes rutas de artículos — es mejor la homepage que una URL falsa
- PDFs universitarios: solo si conoces la URL exacta del PDF

FUENTES CONFIABLES POR TIPO:
- Artículos procesables: Wikipedia ES, Khan Academy ES, SEP (gob.mx), UNAM, enciclopedia.mx
- Videos de apoyo: YouTube (búsqueda general), Canal Once, UNAM en línea
- PDFs: repositorios .unam.mx, .ipn.mx, .sep.gob.mx

Genera exactamente 4 recursos procesables y 3 videos de apoyo.

FORMATO JSON ESTRICTO:
{
  "recursos": [
    {
      "titulo": "Título descriptivo del recurso",
      "fuente": "Nombre del sitio",
      "tipo": "Artículo" | "PDF" | "Video",
      "nivel": "Preparatoria" | "Universidad" | "General",
      "descripcion": "Qué cubre y por qué es útil en 1-2 oraciones",
      "url": "https://url-real-y-verificable.com/ruta",
      "idioma": "Español" | "Inglés",
      "procesable": true | false,
      "esVideo": false | true
    }
  ],
  "consejo": "Consejo pedagógico breve sobre cómo usar estos recursos."
}`;

        const text = await iaCall([
            { role: 'system', content: 'Eres un experto en recursos educativos. Respondes ÚNICAMENTE con JSON válido, sin texto extra, sin markdown.' },
            { role: 'user', content: promptSugerencias }
        ], true);

        const data = JSON.parse(text);
        const recursos = data.recursos || [];

        // ── Paso 2: Verificar URLs reales (HEAD request con timeout corto)
        async function verificarURL(url) {
            try {
                const ctrl = new AbortController();
                const timeout = setTimeout(() => ctrl.abort(), 5000);
                const response = await axios.head(url, {
                    signal: ctrl.signal,
                    timeout: 5000,
                    maxRedirects: 3,
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; educational-bot/1.0)' },
                    validateStatus: s => s < 500 // 200-499 = URL existe
                });
                clearTimeout(timeout);
                return response.status < 400; // 200-399 = accesible
            } catch {
                return false;
            }
        }

        // Verificar en paralelo con límite de concurrencia
        const verificados = await Promise.all(
            recursos.map(async r => {
                const activa = await verificarURL(r.url);
                return { ...r, urlActiva: activa };
            })
        );

        // ── Paso 3: Para URLs caídas de Wikipedia, construir URL alternativa conocida
        const conFallback = verificados.map(r => {
            if (!r.urlActiva) {
                // Si era Wikipedia, construir URL de búsqueda como fallback
                if (r.url.includes('wikipedia.org')) {
                    const busqueda = encodeURIComponent(tema);
                    r.url = `https://es.wikipedia.org/w/index.php?search=${busqueda}`;
                    r.urlActiva = true;
                    r.esFallback = true;
                } else if (r.esVideo || r.tipo === 'Video') {
                    // Videos sin URL válida → búsqueda en YouTube
                    const busqueda = encodeURIComponent(`${tema} explicación educativa`);
                    r.url = `https://www.youtube.com/results?search_query=${busqueda}`;
                    r.urlActiva = true;
                    r.esFallback = true;
                } else {
                    // Otros recursos con URL caída → búsqueda en Google académico
                    const busqueda = encodeURIComponent(`${tema} sitio:edu OR sitio:gob.mx`);
                    r.url = `https://www.google.com/search?q=${busqueda}`;
                    r.urlActiva = true;
                    r.esFallback = true;
                }
            }
            return r;
        });

        // Separar en secciones
        data.paraTarea     = conFallback.filter(r => r.procesable && !r.esVideo && r.tipo !== 'Video');
        data.materialExtra = conFallback.filter(r => !r.procesable || r.esVideo || r.tipo === 'Video');
        data.recursos      = conFallback;

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
                correctas, total, pct, codigo, tareaId, alumnoId } = req.body;
        if (!nombre || !titulo) return res.status(400).json({ error: 'Faltan datos.' });

        let grupoNombre = '';
        if (grupoId) { const g = await Grupo.findById(grupoId); if (g) grupoNombre = g.nombre; }

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

        res.json({ shortId, nuevosLogros });
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

        // Resolver texto si es URL (retorna string o {texto, videoId, esVideo} para YouTube)
        let fuente = input.trim();
        if (fuente.startsWith('http')) fuente = await extraerTextoWeb(fuente);
        const texto = typeof fuente === 'object' ? fuente.texto : fuente;

        // Generar clase + pool de 15 preguntas
        const meta = { maestroId: req.maestro.id };
        const generated = await procesarConIAPool(texto, meta);

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

// Crear tarea desde archivos (fotos/PDF) — igual que tarea texto pero con upload
// ══ EXTRACCIÓN DE IMAGEN CENTRALIZADA — Gemini Vision + GROQ fallback ══
const PROMPT_VISION = `Eres un asistente educativo experto en transcripción y extracción de contenido.

EXTRAE con precisión ABSOLUTA:
- Todo texto escrito: títulos, subtítulos, párrafos, notas, definiciones
- Fórmulas matemáticas, químicas o físicas (en formato legible)
- Fechas, nombres, datos numéricos importantes
- Listas, tablas, esquemas y diagramas (descríbelos con su contenido)
- Cualquier contenido que un estudiante de preparatoria necesite aprender

IGNORA completamente:
- Menús, botones, iconos de navegación
- Publicidad, banners, elementos decorativos  
- Pies de página con información del sitio web
- Elementos de interfaz de usuario

Si es fotografía de apuntes o libro: transcribe el texto COMPLETO con máxima fidelidad.
Si hay ecuaciones: escríbelas en formato texto claro (ej: "E = mc²").
Responde SOLO con el contenido extraído, sin comentarios ni introducciones.`;

async function extractImageText(buf, mime) {
    // Intentar Gemini 2.0 Flash Vision primero (mejor calidad)
    if (GEMINI_KEY) {
        try {
            const body = {
                contents: [{ role: 'user', parts: [
                    { inlineData: { mimeType: mime, data: buf.toString('base64') } },
                    { text: PROMPT_VISION }
                ]}],
                generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
            };
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
                body, { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
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

        const { grupoId } = req.body;
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

        const meta = { maestroId: req.maestro.id };
        const generated = await procesarConIAPool(textoTotal, meta);
        const shortId = await shortIdUnico(Tarea);
        const tarea = await Tarea.create({
            shortId, maestroId: req.maestro.id, grupoId: grupoId || null,
            titulo:    generated.titulo,
            abstract:  generated.abstract || '',
            resumen:   generated.resumen,
            podcast:   generated.podcast || '',
            flashcards: generated.flashcards || [],
            poolPreguntas: generated.poolPreguntas || generated.quiz || [],
            contexto:  textoTotal.substring(0, 10000)
        });
        res.json({ shortId: tarea.shortId, titulo: tarea.titulo, abstract: tarea.abstract });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { for (const p of tmpPaths) await unlink(p).catch(() => {}); }
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
        const { grupoId, tareaIds, titulo, instrucciones, preguntasPorTarea, tiempoLimite } = req.body;
        if (!tareaIds?.length) return res.status(400).json({ error: 'Selecciona al menos una tarea.' });

        const grupo = await Grupo.findOne({ _id: grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        // Obtener tareas y mezclar preguntas
        const tareas = await Tarea.find({
            _id: { $in: tareaIds },
            maestroId: req.maestro.id
        }).select('titulo poolPreguntas').lean();

        if (!tareas.length) return res.status(404).json({ error: 'No se encontraron tareas.' });

        const ppt = preguntasPorTarea || 5; // preguntas por tarea
        let preguntas = [];
        tareas.forEach(t => {
            const pool = t.poolPreguntas || [];
            // Mezclar aleatoriamente y tomar ppt preguntas
            const mezcladas = pool.sort(() => Math.random() - 0.5).slice(0, ppt);
            mezcladas.forEach(q => preguntas.push({ ...q, fuente: t.titulo }));
        });
        // Mezclar el examen completo
        preguntas = preguntas.sort(() => Math.random() - 0.5);

        const shortId = await shortIdUnico(Examen);
        const examen = await Examen.create({
            shortId, maestroId: req.maestro.id, grupoId,
            titulo: titulo || `Examen Final — ${grupo.nombre}`,
            instrucciones: instrucciones || 'Responde cada pregunta. Tienes tiempo limitado.',
            preguntas, tiempoLimite: tiempoLimite || 60, activo: true
        });
        res.json({ shortId: examen.shortId, titulo: examen.titulo, totalPreguntas: preguntas.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar exámenes del maestro
app.get('/api/maestro/examenes', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const examenes = await Examen.find({ maestroId: req.maestro.id })
            .sort({ creadoEn: -1 }).select('-preguntas').lean();
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
        const preguntasSinRespuesta = examen.preguntas.map(q => ({
            p: q.p, o: q.o, fuente: q.fuente // sin q.r (respuesta correcta)
        }));
        res.json({ ...examen, preguntas: preguntasSinRespuesta });
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

// Solicitar reset — genera token y envía email via Resend
app.post('/api/alumno/reset-password', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email requerido.' });

        const alumno = await Alumno.findOne({ email: email.toLowerCase() });
        // Siempre responder OK para no revelar si el email existe
        if (!alumno) return res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });

        // Generar token de 32 chars
        const token = [...Array(32)].map(() => Math.floor(Math.random()*16).toString(16)).join('');
        alumno.resetToken    = token;
        alumno.resetTokenExp = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
        await alumno.save();

        const resetUrl = `${process.env.FRONTEND_URL || 'https://cigd.com.mx/tutor'}/index.html?reset=${token}`;

        // Enviar email via Resend
        const RESEND_KEY = process.env.RESEND_API_KEY;
        if (RESEND_KEY) {
            await axios.post('https://api.resend.com/emails', {
                from:    'Tutor IA <no-reply@brandcollectivemx.com>',
                to:      [alumno.email],
                subject: 'Restablecer contraseña — Tutor IA',
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#080b14;color:#edf0f7;border-radius:16px">
                        <h2 style="color:#a78bfa;margin-bottom:8px">🔐 Restablecer contraseña</h2>
                        <p style="color:#8892a4;margin-bottom:24px">Hola <strong>${alumno.nombre}</strong>, recibimos tu solicitud para restablecer tu contraseña.</p>
                        <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:#7c3aed;color:white;border-radius:10px;text-decoration:none;font-weight:700;margin-bottom:24px">Restablecer contraseña</a>
                        <p style="color:#5e738a;font-size:.82rem">Este link expira en 1 hora. Si no solicitaste esto, ignora este mensaje.</p>
                        <hr style="border:none;border-top:1px solid #1e2d45;margin:24px 0">
                        <p style="color:#5e738a;font-size:.75rem">Tutor IA · Powered by Brand Collective</p>
                    </div>`
            }, {
                headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' }
            });
        }
        res.json({ ok: true, msg: 'Si el email existe, recibirás instrucciones.' });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Confirmar reset con token
app.post('/api/alumno/confirm-reset', async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos.' });
        if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

        const alumno = await Alumno.findOne({
            resetToken: token,
            resetTokenExp: { $gt: new Date() }
        });
        if (!alumno) return res.status(400).json({ error: 'Token inválido o expirado.' });

        alumno.passwordHash  = await bcrypt.hash(password, 10);
        alumno.resetToken    = null;
        alumno.resetTokenExp = null;
        await alumno.save();
        res.json({ ok: true, msg: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
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
                llamadas:     { $count: {} }
            }}
        ]);
        const usage30d = usagePipeline[0] || { tokensTotal: 0, costoTotal: 0, llamadas: 0 };

        // Uso por escuela
        const usagePorEscuela = await UsageLog.aggregate([
            { $match: { creadoEn: { $gte: hace30 }, escuelaId: { $ne: null } } },
            { $group: { _id: '$escuelaId', tokens: { $sum: '$tokensTotal' }, costo: { $sum: '$costoUSD' }, llamadas: { $count: {} } } },
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
                count: { $count: {} }
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

app.listen(PORT, () => console.log(`🚀 Tutor IA en puerto ${PORT} — modelo: ${GROQ_MODEL}`));
