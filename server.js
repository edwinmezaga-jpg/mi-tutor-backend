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
            $('script,style,nav,footer,aside,header').remove();
            return $('h1,h2,h3,p,li').text().replace(/\s+/g,' ').trim();
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
        { role: 'user', content: `Eres un profesor universitario experto. Crea una clase magistral COMPLETA y MUY DETALLADA en español.

INSTRUCCIONES:
- Mínimo 5 párrafos largos y bien desarrollados
- Usa <br><br> entre párrafos y <b>negritas</b> para conceptos clave
- No hagas listas, escribe como clase magistral fluida

JSON EXACTO:
{
  "titulo": "Título específico",
  "resumen": "Clase magistral con <b>negritas</b> y <br><br> entre párrafos",
  "quiz": [
    {"p": "Pregunta 1", "o": ["A", "B", "C", "D"], "r": 0},
    {"p": "Pregunta 2", "o": ["A", "B", "C", "D"], "r": 1},
    {"p": "Pregunta 3", "o": ["A", "B", "C", "D"], "r": 2},
    {"p": "Pregunta 4", "o": ["A", "B", "C", "D"], "r": 3},
    {"p": "Pregunta 5", "o": ["A", "B", "C", "D"], "r": 0},
    {"p": "Pregunta 6", "o": ["A", "B", "C", "D"], "r": 1}
  ],
  "flashcards": [
    {"anverso": "Concepto 1", "definicion": "Qué es", "contexto": "Cómo se usa con ejemplo"},
    {"anverso": "Concepto 2", "definicion": "Qué es", "contexto": "Cómo se usa con ejemplo"},
    {"anverso": "Concepto 3", "definicion": "Qué es", "contexto": "Cómo se usa con ejemplo"},
    {"anverso": "Concepto 4", "definicion": "Qué es", "contexto": "Cómo se usa con ejemplo"},
    {"anverso": "Concepto 5", "definicion": "Qué es", "contexto": "Cómo se usa con ejemplo"},
    {"anverso": "Concepto 6", "definicion": "Qué es", "contexto": "Cómo se usa con ejemplo"}
  ]
}

Contenido: ${sourceText.substring(0, 28000)}` }
    ];

    const text = await groqCall(messages, true);
    const data = JSON.parse(text);
    data.contexto = sourceText.substring(0, 10000);
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

app.post('/api/estudiar-archivo', upload.single('archivo'), async (req, res) => {
    const tmpPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió archivo.' });
        const buf = await readFile(tmpPath);
        const mime = req.file.mimetype;
        let sourceText = '';
        if (mime === 'application/pdf') {
            try { sourceText = (await pdfParse(buf)).text; }
            catch { throw new Error('No se pudo leer el PDF.'); }
        } else if (mime.startsWith('image/')) {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                { model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                  messages: [{ role: 'user', content: [
                      { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } },
                      { type: 'text', text: 'Transcribe todo el texto e información de esta imagen. Sé exhaustivo.' }
                  ]}], max_tokens: 4096 },
                { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
            );
            sourceText = response.data.choices[0].message.content;
        } else {
            sourceText = buf.toString('utf-8');
        }
        if (!sourceText || sourceText.trim().length < 30)
            throw new Error('No se encontró suficiente texto.');
        res.json(await procesarConIA(sourceText));
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (tmpPath) await unlink(tmpPath).catch(() => {}); }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { context, question } = req.body;
        const answer = await groqCall([
            { role: 'system', content: 'Eres un tutor amable. Responde en español de forma concisa.' },
            { role: 'user', content: `Contexto:\n${context}\n\nDuda: ${question}` }
        ]);
        res.json({ answer });
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
                correctas, total, pct, codigo } = req.body;
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
            correctas, total, pct, codigo
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

// Dashboard de un grupo — ver todas las sesiones
app.get('/api/maestro/grupo/:grupoId', verifyToken, async (req, res) => {
    try {
        if (!mongoose.connection.readyState) return res.status(503).json({ error: 'BD no disponible.' });
        // Verificar que el grupo pertenece al maestro
        const grupo = await Grupo.findOne({ _id: req.params.grupoId, maestroId: req.maestro.id });
        if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado.' });

        const sesiones = await Sesion.find({ grupoId: req.params.grupoId })
            .sort({ creadoEn: -1 })
            .select('-__v -chatMensajes');

        // Estadísticas
        const total = sesiones.length;
        const promedio = total ? Math.round(sesiones.reduce((a,s) => a+(s.pct||0), 0) / total) : 0;

        // Preguntas más falladas
        const fallos = {};
        sesiones.forEach(s => {
            (s.respuestasQuiz||[]).forEach(r => {
                if (!r.esCorrecta) fallos[r.pregunta] = (fallos[r.pregunta]||0) + 1;
            });
        });
        const preguntasMasFalladas = Object.entries(fallos)
            .sort((a,b) => b[1]-a[1]).slice(0,5)
            .map(([pregunta, veces]) => ({ pregunta, veces }));

        // Alumnos únicos
        const alumnos = {};
        sesiones.forEach(s => {
            if (!alumnos[s.nombre]) alumnos[s.nombre] = { nombre: s.nombre, sesiones: 0, pctPromedio: 0, ultima: s.fecha };
            alumnos[s.nombre].sesiones++;
            alumnos[s.nombre].pctPromedio = Math.round(
                (alumnos[s.nombre].pctPromedio * (alumnos[s.nombre].sesiones-1) + (s.pct||0)) / alumnos[s.nombre].sesiones
            );
        });

        res.json({ grupo, total, promedio, preguntasMasFalladas, alumnos: Object.values(alumnos), sesiones });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

app.listen(PORT, () => console.log(`🚀 Tutor IA en puerto ${PORT} — modelo: ${GROQ_MODEL}`));
