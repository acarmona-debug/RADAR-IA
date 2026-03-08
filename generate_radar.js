import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const prompt = `
Genera un radar diario de IA en español.

Objetivo:
Entregar novedades reales y útiles sobre inteligencia artificial para trabajo empresarial, automatización, procesos, gestión documental, agentes y productividad.

Incluye solo:
- Google Labs y experimentos nuevos
- Gemini
- OpenAI / ChatGPT
- Claude / Anthropic
- frameworks de agentes, RAG, orquestación o automatización
- tools o apps abiertas o gratuitas con utilidad real
- novedades de IA aplicables a procesos, automatización o trabajo empresarial

Excluye:
- política
- regulación
- hardware
- inversión / funding
- rumores sin fuente seria
- artículos repetidos sobre el mismo evento
- notas sin utilidad práctica

Reglas editoriales:
- agrupa por evento, no por medio
- prioriza novedad verdadera
- prioriza utilidad real
- si varios medios hablan del mismo hecho, trátalo como un solo evento
- escribe todo en español claro y natural

Devuelve SOLO JSON válido, sin markdown y sin texto fuera del JSON.

Estructura obligatoria:
{
  "date": "YYYY-MM-DD",
  "intro_message": "string",
  "items": [
    {
      "category": "labs | model | framework | tool | sector",
      "title": "string",
      "summary": "string",
      "what_changed": "string",
      "why_it_matters": "string",
      "sector_impact": "string",
      "source_name": "string",
      "source_url": "string",
      "status": "new | follow_up",
      "relevance_score": 0,
      "tags": ["string", "string"]
    }
  ]
}

Reglas de calidad:
- genera entre 10 y 15 items si hay suficientes
- relevance_score debe ser numérico de 0 a 10
- summary breve: 1 o 2 oraciones
- what_changed debe explicar el cambio real
- why_it_matters debe explicar por qué importa
- sector_impact debe aterrizarlo a procesos, automatización, gestión documental o trabajo empresarial
- tags debe traer de 2 a 4 etiquetas cortas
- source_url debe ser útil y directo
`;

function readJson(path, fallback) {
  try {
    if (!fs.existsSync(path)) return fallback;
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function detectBrand(text) {
  const t = String(text || "").toLowerCase();

  if (t.includes("google labs")) return "google";
  if (t.includes("gemini")) return "google";
  if (t.includes("openai")) return "openai";
  if (t.includes("chatgpt")) return "openai";
  if (t.includes("anthropic")) return "anthropic";
  if (t.includes("claude")) return "anthropic";
  if (t.includes("crewai")) return "crewai";
  if (t.includes("autogen")) return "autogen";
  if (t.includes("langchain")) return "langchain";
  if (t.includes("llamaindex")) return "llamaindex";

  return "general";
}

function detectAction(item) {
  const text = [
    item.title,
    item.summary,
    item.what_changed,
    item.why_it_matters
  ].join(" ").toLowerCase();

  if (text.includes("launch") || text.includes("lanza") || text.includes("lanz")) return "launch";
  if (text.includes("release") || text.includes("versión") || text.includes("version")) return "release";
  if (text.includes("preview")) return "preview";
  if (text.includes("integración") || text.includes("integration")) return "integration";
  if (text.includes("benchmark")) return "benchmark";
  if (text.includes("feature") || text.includes("función") || text.includes("funcion")) return "feature_update";
  if (text.includes("update") || text.includes("actualiza") || text.includes("actualización") || text.includes("actualizacion")) return "update";

  return "update";
}

function detectEntity(item) {
  const source = String(item.source_name || "");
  const title = String(item.title || "");
  const tags = Array.isArray(item.tags) ? item.tags.join(" ") : "";

  const candidates = `${title} ${source} ${tags}`.toLowerCase();

  const known = [
    "opal",
    "gemini",
    "chatgpt",
    "claude",
    "crewai",
    "autogen",
    "langchain",
    "llamaindex",
    "google labs"
  ];

  for (const k of known) {
    if (candidates.includes(k)) return normalizeText(k);
  }

  const words = title
    .split(/\s+/)
    .map(w => normalizeText(w))
    .filter(Boolean)
    .filter(w => !["de", "la", "el", "los", "las", "para", "con", "y", "en", "un", "una"].includes(w));

  return words.slice(0, 3).join("_") || "item";
}

function buildEventKey(item) {
  return [
    normalizeText(item.category),
    detectBrand(`${item.title} ${item.source_name}`),
    detectEntity(item),
    detectAction(item)
  ].filter(Boolean).join("_");
}

function normalizeItem(item) {
  const normalized = {
    category: ["labs", "model", "framework", "tool", "sector"].includes(item.category)
      ? item.category
      : "tool",
    title: item.title || "Sin título",
    summary: item.summary || "Sin resumen",
    what_changed: item.what_changed || item.summary || "Sin detalle",
    why_it_matters: item.why_it_matters || "Relevancia detectada por el radar.",
    sector_impact:
      item.sector_impact ||
      "Aplicación potencial en procesos, automatización o trabajo empresarial.",
    source_name: item.source_name || "Fuente",
    source_url: item.source_url || "#",
    status: ["new", "follow_up"].includes(item.status) ? item.status : "new",
    relevance_score:
      typeof item.relevance_score === "number"
        ? Math.max(0, Math.min(10, item.relevance_score))
        : 7,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : []
  };

  normalized.event_key = buildEventKey(normalized);
  return normalized;
}

function getHistoryKeys(history) {
  const keys = new Set();

  for (const day of history.days || []) {
    for (const item of day.items || []) {
      if (item.event_key) keys.add(item.event_key);
    }
  }

  return keys;
}

function updateHistory(history, date, items) {
  const nextDays = Array.isArray(history.days) ? [...history.days] : [];

  nextDays.unshift({
    date,
    items: items.map(item => ({
      event_key: item.event_key,
      title: item.title,
      category: item.category,
      source_url: item.source_url
    }))
  });

  return {
    days: nextDays.slice(0, 7)
  };
}

async function run() {
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    max_output_tokens: 2200
  });

  const text = response.output_text;

  try {
    const raw = JSON.parse(text);
    const history = readJson("history.json", { days: [] });
    const historyKeys = getHistoryKeys(history);

    const normalizedItems = Array.isArray(raw.items)
      ? raw.items.map(normalizeItem)
      : [];

    const dedupedItems = normalizedItems
      .filter(item => !historyKeys.has(item.event_key))
      .slice(0, 15);

    const date = raw.date || new Date().toISOString().slice(0, 10);

    const cleaned = {
      date,
      intro_message:
        raw.intro_message ||
        "Hoy hubo movimiento relevante en labs, modelos, frameworks y tools con potencial real para automatización y trabajo empresarial.",
      items: dedupedItems
    };

    const updatedHistory = updateHistory(history, date, dedupedItems);

    fs.writeFileSync("daily.json", JSON.stringify(cleaned, null, 2), "utf8");
    fs.writeFileSync("history.json", JSON.stringify(updatedHistory, null, 2), "utf8");

    console.log("Radar e historial actualizados correctamente");
  } catch (e) {
    console.error("Error parseando JSON:");
    console.error(text);
    process.exit(1);
  }
}

run();
