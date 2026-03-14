// ── Función central con el texto REAL extraído y JSON BLINDADO
async function procesarConIA(sourceText) {
    if (!sourceText || sourceText.length < 20) {
        throw new Error("El texto extraído es demasiado corto o está vacío.");
    }

    const prompt = `Actúa como un tutor experto para estudiantes de secundaria y preparatoria.
Analiza el contenido y responde ÚNICAMENTE con un objeto JSON.

⚠️ REGLAS CRÍTICAS PARA NO ROMPER EL FORMATO:
1. NO uses comillas dobles (") dentro de los textos. Si necesitas citar algo, usa comillas simples (').
2. NO incluyas saltos de línea reales (Enters) en el texto. Usa siempre la etiqueta <br> para separar los párrafos.
3. No incluyas bloques de código markdown como \`\`\`json.

Estructura exacta:
{
  "titulo": "Título claro del tema",
  "resumen": "Clase magistral detallada, explicativa y didáctica usando lenguaje sencillo. Separada por <br><br>.",
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
    if (!jsonMatch) throw new Error('La IA no devolvió un formato reconocible. Intenta de nuevo.');

    let data;
    try {
        // Aquí es donde ocurría tu error. Ahora lo atrapamos con gracia.
        data = JSON.parse(jsonMatch[0]);
    } catch (error) {
        console.error("Error parseando el JSON de Gemini:", error.message);
        throw new Error("La IA generó un formato de texto incompatible. Por favor, haz clic en intentar de nuevo.");
    }

    data.contexto = sourceText.substring(0, 8000);

    console.log('🎨 Generando imagen...');
    const imagen = await generarImagenExplicativa(data.titulo, data.resumen);
    if (imagen) {
        data.imagen = `data:${imagen.mimeType};base64,${imagen.data}`;
    }

    return data;
}
