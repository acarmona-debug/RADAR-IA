const fs = require("fs");
const Parser = require("rss-parser");
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const parser = new Parser({ timeout: 15000 });

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";

const FEEDS = [
  { source: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { source: "Anthropic News", url: "https://www.anthropic.com/news/rss.xml" },
  { source: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" }
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

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return { days: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    if (raw && Array.isArray(raw.days)) return raw;
    return { days: [] };
  } catch {
    return { days: [] };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
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
  const nextDays = Array.isArray(history.days) ? [...history.days] : [];

  nextDays.unshift({
    date,
    executive_title: executiveTitle || "Resumen ejecutivo del día",
    items: items
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
      console.error(`Feed error: ${feed.source}`, err.message);
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

function sectorFilter(items) {
  return items
    .map((item) => ({ ...item, sector_score: scoreItemForSector(item) }))
    .filter((item) => item.sector_score >= 2)
    .sort((a, b) => b.sector_score - a.sector_score);
}

async function run() {
  const history = loadHistory();
  const existingLinks = getHistoryLinks(history);

  let feedItems = await fetchFeedItems();
  feedItems = filterRecent(feedItems);
  feedItems = sectorFilter(feedItems);

  const uniqueByLink = [];
  const seen = new Set();

  for (const item of feedItems) {
    const key = item.source_url.trim();
    if (!seen.has(key) && !existingLinks.has(key)) {
      seen.add(key);
      uniqueByLink.push(item);
    }
  }

  const limited = uniqueByLink.slice(0, 18);

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

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });

  const content = response.choices[0].message.content || "";
  const cleanedContent = content
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const raw = JSON.parse(cleanedContent);
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  const cleanedItems = rawItems
    .filter((item) => item && item.source_url)
    .map((item) => ({
      title: item.title || "",
      summary: item.summary || "",
      category: ["labs", "model", "framework", "tool", "sector"].includes(item.category) ? item.category : "tool",
      source_name: item.source_name || "",
      source_url: item.source_url || "",
      relevance_score: Math.max(0, Math.min(10, Number(item.relevance_score) || 7)),
      status: item.status === "follow_up" ? "follow_up" : "new",
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
      what_changed: item.what_changed || "",
      why_it_matters: item.why_it_matters || "",
      sector_impact: item.sector_impact || ""
    }));

  const date = new Date().toISOString().slice(0, 10);

  const cleaned = {
    date,
    executive_title: raw.executive_title || "Resumen ejecutivo del día",
    intro_message: raw.intro_message || "Radar diario generado a partir de fuentes reales.",
    opening_message:
      raw.opening_message ||
      "Estas son las señales más relevantes del día, filtradas para priorizar herramientas, modelos, frameworks y movimientos con utilidad real para automatización, productividad y trabajo empresarial.",
    items: cleanedItems
  };

  fs.writeFileSync(DAILY_FILE, JSON.stringify(cleaned, null, 2));

  const updatedHistory = updateHistory(
    history,
    cleaned.items,
    date,
    cleaned.executive_title
  );

  saveHistory(updatedHistory);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
