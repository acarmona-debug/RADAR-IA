const fs = require("fs");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "RADAR-IA/1.0"
  }
});

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";
const MAX_FEED_TIME_MS = 10000;
const OPENAI_TIMEOUT_MS = 35000;
const MAX_INPUT_ITEMS = 18;
const MAX_OUTPUT_ITEMS = 8;

const FEEDS = [
  { source: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { source: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { source: "ArXiv AI", url: "https://export.arxiv.org/rss/cs.AI" },
  { source: "LangChain", url: "https://blog.langchain.dev/rss/" },
  { source: "GitHub AI", url: "https://github.blog/tag/ai/feed/" },
  { source: "Microsoft AI", url: "https://blogs.microsoft.com/ai/feed/" },
  { source: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { source: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" }
];

const ALLOW_KEYWORDS = [
  "agent", "agents", "workflow", "automation", "automate", "enterprise",
  "productivity", "assistant", "assistants", "copilot", "rag", "orchestration",
  "framework", "sdk", "api", "workspace", "gemini", "openai", "chatgpt",
  "claude", "anthropic", "model", "models", "llm", "tool", "tools", "app",
  "apps", "builder", "search", "browser", "document", "documents", "knowledge",
  "retrieval", "integration", "integrations", "repo", "github", "developer"
];

const BLOCK_KEYWORDS = [
  "wildlife", "conservation", "ecology", "ecological", "biodiversity", "biology",
  "genomics", "genome", "protein", "proteins", "drug discovery", "clinical",
  "hospital", "medical imaging", "patient", "healthcare", "radiology", "surgery",
  "agriculture", "crop", "satellite", "astronomy", "particle physics"
];

function ensureJsonFile(path, fallback) {
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, JSON.stringify(fallback, null, 2), "utf8");
  }
}

function loadJson(path, fallback) {
  ensureJsonFile(path, fallback);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function getHistoryLinks(history) {
  const links = new Set();
  for (const day of history.days || []) {
    for (const item of day.items || []) {
      if (item && item.source_url) links.add(String(item.source_url).trim());
    }
  }
  return links;
}

function updateHistory(history, items, date, executiveTitle) {
  const days = Array.isArray(history.days) ? [...history.days] : [];
  days.unshift({
    date,
    executive_title: executiveTitle || "Resumen ejecutivo del día",
    items: Array.isArray(items) ? items : []
  });
  return { days: days.slice(0, 7) };
}

function scoreItem(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source_name || ""}`.toLowerCase();
  let score = 0;

  for (const k of ALLOW_KEYWORDS) {
    if (text.includes(k)) score += 2;
  }

  for (const k of BLOCK_KEYWORDS) {
    if (text.includes(k)) score -= 6;
  }

  if (text.includes("chatgpt") || text.includes("gemini") || text.includes("claude")) score += 3;
  if (text.includes("framework") || text.includes("sdk")) score += 2;
  if (text.includes("tool") || text.includes("app")) score += 2;
  if (text.includes("agent")) score += 2;

  return score;
}

function classifyCategory(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source_name || ""}`.toLowerCase();

  if (text.includes("openai") || text.includes("anthropic") || text.includes("google") || text.includes("meta")) return "labs";
  if (text.includes("model") || text.includes("gpt") || text.includes("gemini") || text.includes("claude") || text.includes("llm")) return "model";
  if (text.includes("framework") || text.includes("sdk") || text.includes("langchain") || text.includes("llamaindex")) return "framework";
  if (text.includes("tool") || text.includes("app") || text.includes("assistant") || text.includes("copilot") || text.includes("workspace")) return "tool";
  return "sector";
}

function buildTags(item) {
  const text = `${item.title || ""} ${item.summary || ""}`.toLowerCase();
  const tags = [];
  if (text.includes("agent")) tags.push("agents");
  if (text.includes("workflow")) tags.push("workflow");
  if (text.includes("automation")) tags.push("automation");
  if (text.includes("rag")) tags.push("rag");
  if (text.includes("sdk")) tags.push("sdk");
  if (text.includes("api")) tags.push("api");
  if (text.includes("copilot")) tags.push("copilot");
  if (text.includes("github")) tags.push("github");
  if (text.includes("model")) tags.push("model");
  if (text.includes("enterprise")) tags.push("enterprise");
  return tags.slice(0, 4);
}

function filterRecent(items) {
  const now = Date.now();
  const maxAgeMs = 96 * 60 * 60 * 1000;

  return items.filter((item) => {
    if (!item.title || !item.source_url) return false;
    if (!item.published_at) return true;
    const d = new Date(item.published_at);
    if (Number.isNaN(d.getTime())) return true;
    return now - d.getTime() <= maxAgeMs;
  });
}

function filterRelevant(items) {
  return items
    .map((item) => ({ ...item, sector_score: scoreItem(item) }))
    .filter((item) => item.sector_score >= 2)
    .sort((a, b) => b.sector_score - a.sector_score);
}

function uniqueNewItems(items, historyLinks) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = String(item.source_url || "").trim();
    if (!key || seen.has(key) || historyLinks.has(key)) continue;
    seen.add(key);
    output.push(item);
  }

  return output;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    })
  ]);
}

async function fetchOneFeed(feed) {
  console.log(`Feed start: ${feed.source}`);
  try {
    const parsed = await withTimeout(parser.parseURL(feed.url), MAX_FEED_TIME_MS, feed.source);
    const items = (parsed.items || []).map((item) => ({
      source_name: feed.source,
      title: cleanText(item.title),
      source_url: item.link || item.guid || "",
      published_at: item.isoDate || item.pubDate || "",
      summary: cleanText(item.contentSnippet || item.content || item.summary || "")
    }));
    console.log(`Feed ok: ${feed.source} (${items.length})`);
    return items;
  } catch (err) {
    console.error(`Feed error: ${feed.source} -> ${err.message}`);
    return [];
  }
}

async function fetchFeedItems() {
  const results = await Promise.all(FEEDS.map((feed) => fetchOneFeed(feed)));
  return results.flat();
}

function getApiKey() {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    process.env.API_KEY ||
    process.env.OPENAI_TOKEN ||
    ""
  ).trim();
}

function extractJsonText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) throw new Error("Respuesta vacía de OpenAI");

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No se encontró JSON válido en la respuesta");
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
}

async function callOpenAI(prompt) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log("OpenAI skipped: no API key");
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    console.log("OpenAI start");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    console.log("OpenAI ok");

    if (data.output_text) return data.output_text.trim();

    if (Array.isArray(data.output)) {
      const parts = data.output
        .flatMap((o) => Array.isArray(o.content) ? o.content : [])
        .filter((c) => c.type === "output_text" && c.text)
        .map((c) => c.text);
      return parts.join("\n").trim();
    }

    return null;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`OpenAI timeout after ${OPENAI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildFallbackRadar(items) {
  const date = new Date().toISOString().slice(0, 10);
  return {
    date,
    executive_title: "Radar IA del día",
    intro_message: "Resumen generado automáticamente a partir de fuentes reales.",
    opening_message: "Hoy aparecieron señales relevantes en el ecosistema de IA con posible impacto en herramientas, automatización, agentes y trabajo empresarial.",
    items: items.slice(0, MAX_OUTPUT_ITEMS).map((item, idx) => ({
      title: item.title || `Noticia ${idx + 1}`,
      summary: item.summary || "Actualización relevante detectada en fuentes del ecosistema de IA.",
      category: classifyCategory(item),
      source_name: item.source_name || "",
      source_url: item.source_url || "",
      relevance_score: Math.max(6, Math.min(10, Number(item.sector_score) || 7)),
      status: "new",
      tags: buildTags(item),
      what_changed: "Se detectó una actualización nueva en las fuentes monitoreadas.",
      why_it_matters: "Puede impactar herramientas, flujos, automatización o decisiones sobre adopción tecnológica.",
      sector_impact: "Conviene revisar si esta novedad afecta productividad, desarrollo o estrategia de IA aplicada."
    }))
  };
}

function normalizeRadar(raw, fallbackItems) {
  const base = buildFallbackRadar(fallbackItems);
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];

  const items = rawItems
    .filter((item) => item && item.source_url)
    .slice(0, MAX_OUTPUT_ITEMS)
    .map((item, idx) => {
      const fb = fallbackItems[idx] || {};
      return {
        title: String(item.title || fb.title || "").trim(),
        summary: String(item.summary || fb.summary || "").trim(),
        category: ["labs", "model", "framework", "tool", "sector"].includes(item.category)
          ? item.category
          : classifyCategory(fb),
        source_name: String(item.source_name || fb.source_name || "").trim(),
        source_url: String(item.source_url || fb.source_url || "").trim(),
        relevance_score: Math.max(0, Math.min(10, Number(item.relevance_score) || Number(fb.sector_score) || 7)),
        status: item.status === "follow_up" ? "follow_up" : "new",
        tags: Array.isArray(item.tags)
          ? item.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
          : buildTags(fb),
        what_changed: String(item.what_changed || "Se detectó una actualización nueva en las fuentes monitoreadas.").trim(),
        why_it_matters: String(item.why_it_matters || "Puede impactar herramientas, flujos, automatización o decisiones sobre adopción tecnológica.").trim(),
        sector_impact: String(item.sector_impact || "Conviene revisar si esta novedad afecta productividad, desarrollo o estrategia de IA aplicada.").trim()
      };
    })
    .filter((item) => item.title && item.source_url);

  return {
    date: new Date().toISOString().slice(0, 10),
    executive_title: String(raw?.executive_title || base.executive_title).trim(),
    intro_message: String(raw?.intro_message || base.intro_message).trim(),
    opening_message: String(raw?.opening_message || base.opening_message).trim(),
    items: items.length ? items : base.items
  };
}

async function buildRadarWithAI(items) {
  const prompt = `
Convierte estas notas REALES en un radar diario de IA en español.

Reglas obligatorias:
- Todo el texto final debe estar en español.
- No inventes noticias.
- No inventes links.
- Usa únicamente la información dada.
- Si algo no está claro, resume sin inventar detalles.
- Prioriza utilidad para automatización, agentes, workflows, productividad, enterprise, tools y frameworks.
- Si una nota parece investigación general sin aplicación clara al trabajo empresarial, descártala.
- Clasifica cada item en una sola categoría:
  labs | model | framework | tool | sector

Devuelve SOLO JSON válido con esta estructura:
{
  "executive_title": "string",
  "intro_message": "string",
  "opening_message": "string",
  "items": [
    {
      "title": "string",
      "summary": "string",
      "category": "labs | model | framework | tool | sector",
      "source_name": "string",
      "source_url": "string",
      "relevance_score": 0,
      "status": "new",
      "tags": ["string"],
      "what_changed": "string",
      "why_it_matters": "string",
      "sector_impact": "string"
    }
  ]
}

Máximo ${MAX_OUTPUT_ITEMS} items.

Notas reales:
${JSON.stringify(items.slice(0, MAX_INPUT_ITEMS), null, 2)}
`;

  const rawText = await callOpenAI(prompt);
  if (!rawText) return buildFallbackRadar(items);

  const jsonText = extractJsonText(rawText);
  const parsed = JSON.parse(jsonText);
  return normalizeRadar(parsed, items);
}

async function run() {
  console.log("Radar start");

  const history = loadJson(HISTORY_FILE, { days: [] });
  ensureJsonFile(DAILY_FILE, {
    date: "",
    executive_title: "",
    intro_message: "",
    opening_message: "",
    items: []
  });

  const historyLinks = getHistoryLinks(history);

  let items = await fetchFeedItems();
  console.log(`Feed raw total: ${items.length}`);

  items = filterRecent(items);
  console.log(`Feed recent total: ${items.length}`);

  items = filterRelevant(items);
  console.log(`Feed relevant total: ${items.length}`);

  items = uniqueNewItems(items, historyLinks);
  console.log(`Feed unique new total: ${items.length}`);

  let radar;

  if (!items.length) {
    radar = {
      date: new Date().toISOString().slice(0, 10),
      executive_title: "Sin novedades relevantes",
      intro_message: "No se detectaron novedades nuevas con suficiente relevancia.",
      opening_message: "Hoy no aparecieron señales nuevas con peso suficiente para automatización, agentes, frameworks, herramientas o impacto empresarial.",
      items: []
    };
  } else {
    try {
      radar = await buildRadarWithAI(items);
    } catch (err) {
      console.error(`AI fallback activated -> ${err.message}`);
      radar = buildFallbackRadar(items);
    }
  }

  saveJson(DAILY_FILE, radar);
  saveJson(HISTORY_FILE, updateHistory(history, radar.items, radar.date, radar.executive_title));

  console.log(`Radar ok: ${radar.items.length} items`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Radar generation failed:");
  console.error(err && err.stack ? err.stack : err);

  const safeFallback = {
    date: new Date().toISOString().slice(0, 10),
    executive_title: "Radar IA no disponible",
    intro_message: "La ejecución encontró un error general.",
    opening_message: "Se generó un fallback seguro para evitar que el flujo se rompa por completo.",
    items: []
  };

  try {
    saveJson(DAILY_FILE, safeFallback);
  } catch {}

  process.exit(0);
});
