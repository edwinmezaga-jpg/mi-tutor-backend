// ═══════════════════════════════════════════════════════════════════════
//  TUTOR IA — aiClient.js
//  Cliente unificado de IA. Encapsula Gemini (principal) + Groq (fallback).
//  Aporta: structured output (responseSchema), grounding, retry exponencial,
//  validación post-llamada, telemetría in-memory y router de intención.
// ═══════════════════════════════════════════════════════════════════════

const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GROQ_KEY    = process.env.GROQ_API_KEY;

// Modelos por tarea — sobre-escribibles por env
const MODEL_LESSON = process.env.GEMINI_MODEL_LESSON || 'gemini-2.5-flash';
const MODEL_CHAT   = process.env.GEMINI_MODEL_CHAT   || 'gemini-2.5-flash-lite';
const MODEL_GROQ   = process.env.GROQ_MODEL          || 'llama-3.3-70b-versatile';

// Compat: si solo se setea GEMINI_MODEL (legacy), úsalo para lecciones
const LEGACY_MODEL = process.env.GEMINI_MODEL;
const RESOLVED_LESSON_MODEL = LEGACY_MODEL || MODEL_LESSON;

// ── Telemetría
const telemetry = {
    gemini: { calls: 0, ok: 0, fail: 0, totalMs: 0, lastError: null, lastOkAt: null },
    groq:   { calls: 0, ok: 0, fail: 0, totalMs: 0, lastError: null, lastOkAt: null },
    schemaFails: 0
};

export function getTelemetry() {
    const fmt = (p) => ({
        calls: p.calls,
        ok: p.ok,
        fail: p.fail,
        successRate: p.calls ? +(p.ok / p.calls).toFixed(3) : null,
        avgLatencyMs: p.ok ? Math.round(p.totalMs / p.ok) : null,
        lastError: p.lastError,
        lastOkAt: p.lastOkAt
    });
    return {
        gemini: fmt(telemetry.gemini),
        groq:   fmt(telemetry.groq),
        schemaFails: telemetry.schemaFails,
        config: {
            geminiKeySet: !!GEMINI_KEY,
            groqKeySet:   !!GROQ_KEY,
            modelLesson:  RESOLVED_LESSON_MODEL,
            modelChat:    MODEL_CHAT,
            modelGroq:    MODEL_GROQ
        }
    };
}

// ── Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pickJsonFromText(text) {
    if (!text || typeof text !== 'string') return null;
    // Intento directo
    try { return JSON.parse(text); } catch {}
    // Buscar primer { o [ … hasta el último } o ]
    const first = text.indexOf('{');
    const firstArr = text.indexOf('[');
    let start = -1;
    if (first === -1 && firstArr === -1) return null;
    if (first === -1) start = firstArr;
    else if (firstArr === -1) start = first;
    else start = Math.min(first, firstArr);
    const isObj = text[start] === '{';
    const last = text.lastIndexOf(isObj ? '}' : ']');
    if (last <= start) return null;
    try { return JSON.parse(text.slice(start, last + 1)); } catch {}
    return null;
}

// ── Validador contra schema (subset de JSON Schema lo necesario)
//
// Soporta type: object|array|string|number|integer|boolean
// properties, required (array), items (para array), minLength, minItems
//
// Retorna { ok, errors:[paths], cleaned: valor }
export function validateAgainstSchema(value, schema, path = '$') {
    const errors = [];
    if (!schema || typeof schema !== 'object') return { ok: true, errors, cleaned: value };

    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            errors.push(`${path}: se esperaba object`);
            return { ok: false, errors, cleaned: value };
        }
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (value[key] === undefined || value[key] === null || value[key] === '') {
                errors.push(`${path}.${key}: campo requerido faltante`);
            }
        }
        if (schema.properties) {
            for (const [key, sub] of Object.entries(schema.properties)) {
                if (value[key] === undefined) continue;
                const sr = validateAgainstSchema(value[key], sub, `${path}.${key}`);
                errors.push(...sr.errors);
            }
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            errors.push(`${path}: se esperaba array`);
            return { ok: false, errors, cleaned: value };
        }
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            errors.push(`${path}: se esperaban al menos ${schema.minItems} elementos (recibidos ${value.length})`);
        }
        if (schema.items) {
            value.forEach((item, i) => {
                const sr = validateAgainstSchema(item, schema.items, `${path}[${i}]`);
                errors.push(...sr.errors);
            });
        }
    } else if (schema.type === 'string') {
        if (typeof value !== 'string') {
            errors.push(`${path}: se esperaba string`);
        } else if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            errors.push(`${path}: string demasiado corto (mínimo ${schema.minLength})`);
        }
    } else if (schema.type === 'number' || schema.type === 'integer') {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            errors.push(`${path}: se esperaba número`);
        } else if (schema.type === 'integer' && !Number.isInteger(value)) {
            errors.push(`${path}: se esperaba entero`);
        }
    } else if (schema.type === 'boolean') {
        if (typeof value !== 'boolean') errors.push(`${path}: se esperaba boolean`);
    }

    return { ok: errors.length === 0, errors, cleaned: value };
}

// ── Llamada a Gemini con retry exponencial
async function geminiFetchOnce({ model, body, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = json?.error?.message || `HTTP ${res.status}`;
            const err = new Error(`Gemini ${model}: ${msg}`);
            err.status = res.status;
            err.body = json;
            throw err;
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Llama a Gemini con retry y devuelve un objeto:
 *   { ok, data, raw, model, usedFallback, errors }
 *
 * @param {object} opts
 * @param {string} opts.prompt           — user prompt
 * @param {string} [opts.systemInstruction] — instrucciones del sistema
 * @param {object} [opts.responseSchema] — esquema JSON para structured output
 * @param {boolean} [opts.grounding]     — activa google_search (no compatible con responseSchema)
 * @param {string} [opts.model]          — gemini-2.5-flash | gemini-2.5-flash-lite
 * @param {number} [opts.timeoutMs]      — default 30000
 * @param {number} [opts.retries]        — default 3
 * @param {number} [opts.temperature]    — default 0.7
 */
export async function callGemini({
    prompt,
    systemInstruction,
    responseSchema,
    grounding = false,
    model = RESOLVED_LESSON_MODEL,
    timeoutMs = 30000,
    retries = 3,
    temperature = 0.7
}) {
    if (!GEMINI_KEY) {
        return { ok: false, data: null, raw: null, model, errors: ['GEMINI_API_KEY no configurada'] };
    }

    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            temperature,
            ...(responseSchema ? {
                responseMimeType: 'application/json',
                responseSchema
            } : {})
        }
    };
    if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (grounding) {
        body.tools = [{ google_search: {} }];
        // Grounding es incompatible con responseSchema — quitamos schema si vino
        delete body.generationConfig.responseSchema;
    }

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        const t0 = Date.now();
        telemetry.gemini.calls++;
        try {
            const json = await geminiFetchOnce({ model, body, timeoutMs });
            const ms = Date.now() - t0;
            const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
            telemetry.gemini.ok++;
            telemetry.gemini.totalMs += ms;
            telemetry.gemini.lastOkAt = new Date().toISOString();

            // Citaciones de grounding (si hay)
            const groundingMeta = json?.candidates?.[0]?.groundingMetadata || null;

            // Si pidieron responseSchema, devolvemos el JSON parseado y validado
            if (responseSchema) {
                const parsed = pickJsonFromText(text);
                if (!parsed) {
                    telemetry.schemaFails++;
                    return { ok: false, data: null, raw: text, model, errors: ['Respuesta no contenía JSON parseable'] };
                }
                const v = validateAgainstSchema(parsed, responseSchema);
                if (!v.ok) {
                    telemetry.schemaFails++;
                    return { ok: false, data: parsed, raw: text, model, errors: v.errors };
                }
                return { ok: true, data: parsed, raw: text, model, errors: [], groundingMeta };
            }
            // Sin schema: devolvemos texto crudo
            return { ok: true, data: text, raw: text, model, errors: [], groundingMeta };
        } catch (e) {
            telemetry.gemini.fail++;
            telemetry.gemini.lastError = e.message;
            lastError = e;
            // 4xx (excepto 429) no se reintentan
            if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
            if (attempt < retries - 1) await sleep(500 * Math.pow(2, attempt));
        }
    }
    return { ok: false, data: null, raw: null, model, errors: [lastError?.message || 'Falló Gemini sin razón conocida'] };
}

// ── Llamada a Groq como fallback (no soporta grounding ni responseSchema nativo)
export async function callGroq({ prompt, systemInstruction, jsonMode = false, model = MODEL_GROQ, timeoutMs = 30000, temperature = 0.7 }) {
    if (!GROQ_KEY) {
        return { ok: false, data: null, raw: null, model, errors: ['GROQ_API_KEY no configurada'] };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    telemetry.groq.calls++;
    try {
        const messages = [];
        if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
        messages.push({ role: 'user', content: prompt });

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_KEY}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature,
                ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
            }),
            signal: controller.signal
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = json?.error?.message || `HTTP ${res.status}`;
            telemetry.groq.fail++;
            telemetry.groq.lastError = msg;
            return { ok: false, data: null, raw: null, model, errors: [`Groq: ${msg}`] };
        }
        const text = json?.choices?.[0]?.message?.content || '';
        const ms = Date.now() - t0;
        telemetry.groq.ok++;
        telemetry.groq.totalMs += ms;
        telemetry.groq.lastOkAt = new Date().toISOString();
        if (jsonMode) {
            const parsed = pickJsonFromText(text);
            return { ok: !!parsed, data: parsed, raw: text, model, errors: parsed ? [] : ['JSON inválido'] };
        }
        return { ok: true, data: text, raw: text, model, errors: [] };
    } catch (e) {
        telemetry.groq.fail++;
        telemetry.groq.lastError = e.message;
        return { ok: false, data: null, raw: null, model, errors: [e.message] };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Wrapper que intenta Gemini → Groq (si responseSchema, valida en ambos).
 * Para bugs como el de "crear contenido" del profesor: si ambos fallan,
 * devuelve { ok: false, errors } y el endpoint debe responder 422.
 */
export async function callIA({ prompt, systemInstruction, responseSchema, model, grounding, temperature, timeoutMs }) {
    const g = await callGemini({ prompt, systemInstruction, responseSchema, model, grounding, temperature, timeoutMs });
    if (g.ok) return { ...g, source: 'gemini' };

    // Fallback Groq sin grounding ni schema-validation estricta
    const groqRes = await callGroq({ prompt, systemInstruction, jsonMode: !!responseSchema, temperature, timeoutMs });
    if (!groqRes.ok) return { ...groqRes, source: 'none', errors: [...g.errors, ...groqRes.errors] };

    // Si pidieron schema, validamos también la respuesta de Groq
    if (responseSchema && groqRes.data) {
        const v = validateAgainstSchema(groqRes.data, responseSchema);
        if (!v.ok) {
            telemetry.schemaFails++;
            return { ok: false, data: groqRes.data, raw: groqRes.raw, model: groqRes.model, source: 'groq', errors: v.errors };
        }
    }
    return { ...groqRes, source: 'groq' };
}

// ─────────────────────────────────────────────────────────────────────────
//  Router de intención — usado por /api/chat para el alumno
// ─────────────────────────────────────────────────────────────────────────

const INTENT_SCHEMA = {
    type: 'object',
    required: ['intent', 'confianza'],
    properties: {
        intent:        { type: 'string' },     // 'leccion' | 'duda' | 'seguimiento' | 'fuera_tema'
        tema:          { type: 'string' },
        gradoSugerido: { type: 'string' },
        confianza:     { type: 'number' },
        razon:         { type: 'string' }
    }
};

const INTENT_SYSTEM = `Eres un router de intención para un Tutor IA escolar (preparatoria/secundaria).
Clasifica el mensaje del alumno en exactamente UNA categoría:
  - "leccion": el alumno expresa que quiere APRENDER un tema NUEVO o pidió explícitamente una clase/lección/explicación completa.
    Ejemplos: "quiero aprender fotosíntesis", "explícame cómo funciona la mitosis", "enséñame derivadas", "no sé nada de la revolución mexicana", "ayúdame con álgebra básica".
  - "duda": pregunta puntual o concepto específico sobre algo que YA está estudiando o sabe.
    Ejemplos: "qué es la mitocondria", "diferencia entre mitosis y meiosis", "cuánto es 5x7", "cómo se conjuga ser en pasado".
  - "seguimiento": continuación de un tema anterior (responde un quiz, pide otro ejemplo, "y entonces?", "explícame ese paso").
  - "fuera_tema": no es académico (saludos, conversación general, off-topic).

Responde SOLO en JSON válido con: intent, tema (string corto del tema detectado o ""), gradoSugerido ("" si no se puede deducir), confianza (0-1), razon (explicación breve).
Si confianza < 0.6 prefiere "duda" sobre "leccion".`;

export async function clasificarIntencion(mensaje, contextoAlumno = '') {
    if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length < 2) {
        return { intent: 'fuera_tema', tema: '', gradoSugerido: '', confianza: 1, razon: 'mensaje vacío' };
    }
    const prompt = [
        contextoAlumno ? `Contexto del alumno: ${contextoAlumno}` : '',
        `Mensaje del alumno: """${mensaje.slice(0, 500)}"""`
    ].filter(Boolean).join('\n\n');

    const r = await callGemini({
        prompt,
        systemInstruction: INTENT_SYSTEM,
        responseSchema: INTENT_SCHEMA,
        model: MODEL_CHAT,
        temperature: 0.1,
        timeoutMs: 10000,
        retries: 2
    });

    if (!r.ok || !r.data) {
        // Heurística mínima de fallback para no bloquear al alumno
        const lower = mensaje.toLowerCase();
        const wantsLesson = /(?:quiero aprender|enséñame|ensename|explícame todo|ensename todo|haz una lección|hazme una clase|dame una clase|aprender sobre)/i.test(lower);
        return {
            intent: wantsLesson ? 'leccion' : 'duda',
            tema: wantsLesson ? mensaje.replace(/quiero aprender|enséñame|aprender sobre/gi, '').trim().slice(0, 80) : '',
            gradoSugerido: '',
            confianza: 0.55,
            razon: 'fallback heurístico (router IA falló)'
        };
    }
    const out = r.data;
    out.intent = ['leccion', 'duda', 'seguimiento', 'fuera_tema'].includes(out.intent) ? out.intent : 'duda';
    out.confianza = typeof out.confianza === 'number' ? Math.max(0, Math.min(1, out.confianza)) : 0.5;
    return out;
}

// ─────────────────────────────────────────────────────────────────────────
//  Schemas reusables para el resto del backend
// ─────────────────────────────────────────────────────────────────────────

export const SCHEMA_TAREA_MIN = {
    type: 'object',
    required: ['titulo', 'resumen'],
    properties: {
        titulo:            { type: 'string', minLength: 4 },
        resumen:           { type: 'string', minLength: 30 },
        ejemplosPracticos: { type: 'array' },
        quiz:              { type: 'array' },
        flashcards:        { type: 'array' }
    }
};

export const SCHEMA_LECCION_COMPLETA = {
    type: 'object',
    required: ['titulo', 'resumen'],
    properties: {
        titulo:    { type: 'string', minLength: 4 },
        abstract:  { type: 'string' },
        resumen:   { type: 'string', minLength: 100 },
        podcast:   { type: 'string' },
        glosario:  { type: 'array' },
        ejemplosPracticos: { type: 'array' },
        quiz:      { type: 'array', minItems: 3 },
        flashcards:{ type: 'array' },
        fuentes:   { type: 'array' }
    }
};

export const MODELS = { LESSON: RESOLVED_LESSON_MODEL, CHAT: MODEL_CHAT, GROQ: MODEL_GROQ };
