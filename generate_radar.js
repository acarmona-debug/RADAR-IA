const fs = require("fs");
const Parser = require("rss-parser");

const parser = new Parser({ timeout: 15000 });

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";

const FEEDS = [
  // LABS / EMPRESAS IA
  { source: "OpenAI", url: "https://openai.com/blog/rss.xml" },
  { source: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { source: "DeepMind", url: "https://deepmind.google/discover/blog/rss/" },
  { source: "Anthropic", url: "https://www.anthropic.com/news/rss.xml" },
  { source: "Meta AI", url: "https://ai.meta.com/blog/rss/" },

  // MODELOS / RESEARCH
  { source: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { source: "Papers With Code", url: "https://paperswithcode.com/rss/latest" },
  { source: "ArXiv AI", url: "https://export.arxiv.org/rss/cs.AI" },

  // FRAMEWORKS / AGENTS
  { source: "LangChain", url: "https://blog.langchain.dev/rss/" },
  { source: "LlamaIndex", url: "https://www.llamaindex.ai/blog/rss.xml" },

  // DEV / ECOSISTEMA
  { source: "GitHub AI", url: "https://github.blog/tag/ai/feed/" },
  { source: "Microsoft AI", url: "https://blogs.microsoft.com/ai/feed/" },

  // INDUSTRIA / STARTUPS
  { source: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { source: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" }
];

const ALLOW_KEYWORDS = [
  "agent", "agents", "workflow", "automation", "automate", "enterprise",
  "productivity", "assistant", "assistants", "copilot", "rag", "orchestration",
  "orchestrator", "framework", "sdk", "api", "workspace", "gemini", "openai",
  "chatgpt", "claude", "anthropic", "google ai", "google labs", "model",
  "llm", "tool", "tools", "app", "apps", "builder", "search", "browser",
  "document", "documents", "knowledge", "retrieval", "integration", "integrations"
];

const BLOCK_KEYWORDS = [
  "wildlife", "conservation", "ecology", "ecological", "biodiversity", "biology",
  "genomics", "genome", "protein", "proteins", "drug discovery", "clinical",
  "hospital", "medical imaging", "patient", "healthcare", "radiology", "surgery",
  "agriculture", "crop", "satellite", "astronomy", "particle physics"
];

function ensureJsonFile(filePath, fallbackData) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackData, null, 2), "utf8");
  }
}

function loadHistory() {
  ensureJsonFile(HISTORY_FILE, { days: [] });

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
    .replace(/\s+/g, " ")
    .trim();
}

function scoreItemForSector(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source_name || ""}`.toLowerCase();
  let score = 0;

  for (const k of ALLOW_KEYWORDS) {
    if (text.includes(k)) score += 2;
  }

  for (const k of BLOCK_KEYWORDS) {
    if (text.includes(k)) score -= 6;
  }

  if (text.includes("gemini") || text.includes("chatgpt") || text.includes("claude")) score += 3;
  if (text.includes("google labs") || text.includes("labs")) score += 2;
  if (text.includes("framework") || text.includes("tool") || text.includes("app")) score += 2;

  return score;
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
  const maxAgeMs = 1000 * 60 * 60 * 96; // 96 horas

  return items.filter((item) => {
    if (!item.title || !item.source_url) return false;
    if (!item.published_at) return true;

    const d = new Date(item.published_at);
    if (Number.isNaN(d.getTime())) return true;

    return now - d <= maxAgeMs;
  });
}

function sectorFilter(items) {
  return items
    .map((item) => ({ ...item, sector_score: scoreItemForSector(item) }))
    .filter((item) => item.sector_score >= 2)
    .sort((a, b) => b.sector_score - a.sector_score);
}

function extractJsonText(rawText) {
  const text = String(rawText || "").trim();

  if (!text) {
    throw new Error("OpenAI devolvió respuesta vacía");
  }

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No se encontró un JSON válido en la respuesta");
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
}

async function callOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Falta OPENAI_API_KEY en los secrets del repositorio");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
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

  let content = "";

  if (data.output_text) {
    content = data.output_text;
  } else if (Array.isArray(data.output)) {
    const parts = data.output
      .flatMap((o) => Array.isArray(o.content) ? o.content : [])
      .filter((c) => c.type === "output_text" && c.text)
      .map((c) => c.text);

    content = parts.join("\n");
  }

  return content.trim();
}

function normalizeRadar(raw) {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  const cleanedItems = rawItems
    .filter((item) => item && item.source_url)
    .slice(0, 8)
    .map((item) => ({
      title: String(item.title || "").trim(),
      summary: String(item.summary || "").trim(),
      category: ["labs", "model", "framework", "tool", "sector"].includes(item.category)
        ? item.category
        : "tool",
      source_name: String(item.source_name || "").trim(),
      source_url: String(item.source_url || "").trim(),
      relevance_score: Math.max(0, Math.min(10, Number(item.relevance_score) || 7)),
      status: item.status === "follow_up" ? "follow_up" : "new",
      tags: Array.isArray(item.tags)
        ? item.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
        : [],
      what_changed: String(item.what_changed || "").trim(),
      why_it_matters: String(item.why_it_matters || "").trim(),
      sector_impact: String(item.sector_impact || "").trim()
    }))
    .filter((item) => item.title && item.source_url);

  const date = new Date().toISOString().slice(0, 10);

  return {
    date,
    executive_title: String(raw.executive_title || "Resumen ejecutivo del día").trim(),
    intro_message: String(raw.intro_message || "Radar diario generado a partir de fuentes reales.").trim(),
    opening_message: String(
      raw.opening_message ||
      "Estas son las señales más relevantes del día, filtradas para priorizar herramientas, modelos, frameworks y movimientos con utilidad real para automatización, productividad y trabajo empresarial."
    ).trim(),
    items: cleanedItems
  };
}

async function run() {
  ensureJsonFile(HISTORY_FILE, { days: [] });
  ensureJsonFile(DAILY_FILE, {
    date: "",
    executive_title: "",
    intro_message: "",
    opening_message: "",
    items: []
  });

  const history = loadHistory();
  const existingLinks = getHistoryLinks(history);

  let feedItems = await fetchFeedItems();
  feedItems = filterRecent(feedItems);
  feedItems = sectorFilter(feedItems);

  const uniqueByLink = [];
  const seen = new Set();

  for (const item of feedItems) {
    const key = String(item.source_url || "").trim();
    if (!key) continue;

    if (!seen.has(key) && !existingLinks.has(key)) {
      seen.add(key);
      uniqueByLink.push(item);
    }
  }

  const limited = uniqueByLink.slice(0, 18);

  if (limited.length === 0) {
    const date = new Date().toISOString().slice(0, 10);
    const emptyRadar = {
      date,
      executive_title: "Sin novedades relevantes",
      intro_message: "No se encontraron novedades suficientemente relevantes en las fuentes revisadas.",
      opening_message: "Hoy no aparecieron señales nuevas con peso suficiente para automatización, agentes, frameworks, tools o impacto empresarial.",
      items: []
    };

    fs.writeFileSync(DAILY_FILE, JSON.stringify(emptyRadar, null, 2), "utf8");
    saveHistory(updateHistory(history, [], date, emptyRadar.executive_title));
    return;
  }

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
- La apertura debe ser más inmersiva, con más cuerpo, más narrativa y más contexto.
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
${JSON.stringify(limited, null, 2)}
`;

  const rawText = await callOpenAI(prompt);
  const jsonText = extractJsonText(rawText);
  const parsed = JSON.parse(jsonText);
  const cleaned = normalizeRadar(parsed);

  fs.writeFileSync(DAILY_FILE, JSON.stringify(cleaned, null, 2), "utf8");

  const updatedHistory = updateHistory(
    history,
    cleaned.items,
    cleaned.date,
    cleaned.executive_title
  );

  saveHistory(updatedHistory);
}

run().catch((err) => {
  console.error("Radar generation failed:");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
