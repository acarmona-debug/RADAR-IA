const fs = require("fs");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 RADAR-IA/1.0"
  }
});

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";

/*
  Dejé fuera los feeds que en tu log dieron 404.
  Si luego quieres, los reintentamos uno por uno.
*/
const FEEDS = [
  { source: "OpenAI", url: "https://openai.com/news/rss.xml" },
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
  "claude", "anthropic", "model", "llm", "tool", "tools", "app", "apps",
  "builder", "search", "browser", "document", "documents", "knowledge",
  "retrieval", "integration", "integrations", "coding", "developer", "repo",
  "github", "ai", "artificial intelligence"
];

const BLOCK_KEYWORDS = [
  "wildlife", "conservation", "ecology", "ecological", "biodiversity", "biology",
  "genomics", "genome", "protein", "proteins", "drug discovery", "clinical",
  "hospital", "medical imaging", "patient", "healthcare", "radiology", "surgery",
  "agriculture", "crop", "satellite", "astronomy", "particle physics"
];

function ensureFile(filePath, fallbackData) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
  }
}

function loadHistory() {
  ensureFile(HISTORY_FILE, { days: [] });

  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (raw && Array.isArray(raw.days)) return raw;
    return { days: [] };
  } catch {
    return { days: [] };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

function getHistoryLinks(history) {
  const links = new Set();

  for (const day of history.days || []) {
    for (const item of day.items || []) {
      if (item && item.source_url) {
        links.add(String(item.source_url).trim());
      }
    }
  }

  return links;
}

function updateHistory(history, items, date, executiveTitle) {
  const nextDays = Array.isArray(history.days) ? [...history.days] : [];

  nextDays.unshift({
    date,
    executive_title: executiveTitle || "Resumen ejecutivo del día",
    items: Array.isArray(items) ? items : []
  });

  return { days: nextDays.slice(0, 7) };
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
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
  if (text.includes("github")) score += 1;

  return score;
}

function classifyCategory(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source_name || ""}`.toLowerCase();

  if (
    text.includes("openai") ||
    text.includes("google") ||
    text.includes("deepmind") ||
    text.includes("anthropic") ||
    text.includes("meta")
  ) {
    return "labs";
  }

  if (
    text.includes("model") ||
    text.includes("llm") ||
    text.includes("gpt") ||
    text.includes("gemini") ||
    text.includes("claude")
  ) {
    return "model";
  }

  if (
    text.includes("framework") ||
    text.includes("sdk") ||
    text.includes("library") ||
    text.includes("langchain") ||
    text.includes("llamaindex")
  ) {
    return "framework";
  }

  if (
    text.includes("tool") ||
    text.includes("app") ||
    text.includes("assistant") ||
    text.includes("copilot") ||
    text.includes("workspace")
  ) {
    return "tool";
  }

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

async function fetchFeedItems() {
  const collected = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        collected.push({
          source_name: feed.source,
          title: cleanText(item.title),
          source_url: item.link || item.guid || "",
          published_at: item.isoDate || item.pubDate || "",
          summary: cleanText(item.contentSnippet || item.content || item.summary || "")
        });
      }
    } catch (err) {
      console.error(`Feed error: ${feed.source} -> ${err.message}`);
    }
  }

  return collected;
}

function filterRecent(items) {
  const now = new Date();
  const maxAgeMs = 1000 * 60 * 60 * 96;

  return items.filter((item) => {
    if (!item.title || !item.source_url) return false;
    if (!item.published_at) return true;

    const d = new Date(item.published_at);
    if (Number.isNaN(d.getTime())) return true;

    return now - d <= maxAgeMs;
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
  const out = [];

  for (const item of items) {
    const key = String(item.source_url || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    if (historyLinks.has(key)) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
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

  if (!text) {
    throw new Error("Respuesta vacía de OpenAI");
  }

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No se encontró JSON válido");
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
}

async function callOpenAI(prompt) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: prompt
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText}`);
  }

  const data = await response.json();

  if (data.output_text) return data.output_text.trim();

  if (Array.isArray(data.output)) {
    const parts = data.output
      .flatMap((o) => Array.isArray(o.content) ? o.content : [])
      .filter((c) => c.type === "output_text" && c.text)
      .map((c) => c.text);

    return parts.join("\n").trim();
  }

  return null;
}

function buildFallbackRadar(items) {
  const date = new Date().toISOString().slice(0, 10);

  const cleanedItems = items.slice(0, 8).map((item, idx) => ({
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
  }));

  return {
    date,
    executive_title: "Radar IA del día",
    intro_message: "Resumen generado automáticamente a partir de fuentes reales.",
    opening_message: "Hoy aparecieron señales relevantes en el ecosistema de IA con posible impacto en herramientas, automatización, agentes y trabajo empresarial.",
    items: cleanedItems
  };
}

function normalizeRadar(raw, fallbackItems) {
  const base = buildFallbackRadar(fallbackItems);
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];

  const cleanedItems = rawItems
    .filter((item) => item && item.source_url)
    .slice(0, 8)
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
    date: base.date,
    executive_title: String(raw?.executive_title || base.executive_title).trim(),
    intro_message: String(raw?.intro_message || base.intro_message).trim(),
    opening_message: String(raw?.opening_message || base.opening_message).trim(),
    items: cleanedItems.length ? cleanedItems : base.items
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

Máximo 8 items.

Notas reales:
${JSON.stringify(items.slice(0, 18), null, 2)}
`;

  const rawText = await callOpenAI(prompt);
  if (!rawText) {
    return buildFallbackRadar(items);
  }

  const jsonText = extractJsonText(rawText);
  const parsed = JSON.parse(jsonText);
  return normalizeRadar(parsed, items);
}

async function run() {
  ensureFile(HISTORY_FILE, { days: [] });
  ensureFile(DAILY_FILE, {
    date: "",
    executive_title: "",
    intro_message: "",
    opening_message: "",
    items: []
  });

  const history = loadHistory();
  const historyLinks = getHistoryLinks(history);

  let items = await fetchFeedItems();
  items = filterRecent(items);
  items = filterRelevant(items);
  items = uniqueNewItems(items, historyLinks);

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

  fs.writeFileSync(DAILY_FILE, JSON.stringify(radar, null, 2), "utf8");

  const updatedHistory = updateHistory(
    history,
    radar.items,
    radar.date,
    radar.executive_title
  );

  saveHistory(updatedHistory);
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
    fs.writeFileSync(DAILY_FILE, JSON.stringify(safeFallback, null, 2), "utf8");
  } catch {}

  process.exit(0);
});
