const fs = require("fs");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 10000,
  headers: { "User-Agent": "RADAR-IA/1.0" }
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
  "framework", "sdk", "api", "workspace", "model", "models", "llm", "tool",
  "tools", "app", "apps", "builder", "search", "browser", "document",
  "documents", "knowledge", "retrieval", "integration", "integrations",
  "developer", "developers", "repo", "github", "ai"
];

const BLOCK_KEYWORDS = [
  "wildlife", "biology", "genomics", "hospital", "patient", "healthcare",
  "agriculture", "astronomy", "particle physics", "policy", "regulation",
  "government", "white house", "senate", "congress"
];

const PRIORITY_TERMS = [
  "cursor", "chatgpt", "gpt", "gpt-4", "gpt-5",
  "claude", "anthropic", "gemini", "google ai", "deepmind"
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

function scoreItem(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source_name || ""}`.toLowerCase();
  let score = 0;

  ALLOW_KEYWORDS.forEach((k) => {
    if (text.includes(k)) score += 2;
  });

  BLOCK_KEYWORDS.forEach((k) => {
    if (text.includes(k)) score -= 6;
  });

  PRIORITY_TERMS.forEach((k) => {
    if (text.includes(k)) score += 5;
  });

  return score;
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

function uniqueNewItems(items, historyLinks) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = String(item.source_url || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    if (historyLinks.has(key)) continue;

    seen.add(key);
    output.push(item);
  }

  return output;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    })
  ]);
}

async function fetchOneFeed(feed) {
  console.log("Feed start:", feed.source);

  try {
    const parsed = await withTimeout(
      parser.parseURL(feed.url),
      MAX_FEED_TIME_MS,
      feed.source
    );

    const items = (parsed.items || []).map((i) => ({
      source_name: feed.source,
      title: cleanText(i.title),
      source_url: i.link || i.guid || "",
      published_at: i.isoDate || i.pubDate || "",
      summary: cleanText(i.contentSnippet || i.content || i.summary || "")
    }));

    console.log("Feed ok:", feed.source, items.length);
    return items;
  } catch (err) {
    console.log("Feed error:", feed.source, err.message);
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

async function callOpenAI(prompt) {
  const key = getApiKey();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    console.log("OpenAI start");

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt
      }),
      signal: controller.signal
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status} ${JSON.stringify(data)}`);
    }

    console.log("OpenAI ok");

    if (data.output_text) return data.output_text;

    if (Array.isArray(data.output)) {
      const parts = data.output
        .flatMap((o) => o.content || [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text);

      return parts.join("\n");
    }

    return null;
  } catch (err) {
    console.log("OpenAI error:", err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  const raw = String(text || "").trim();
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("JSON not found");
  }

  return cleaned.slice(start, end + 1);
}

function classifyCategory(item) {
  const text = `${item.title || ""} ${item.summary || ""} ${item.source_name || ""}`.toLowerCase();

  if (
    text.includes("openai") ||
    text.includes("google") ||
    text.includes("deepmind") ||
    text.includes("anthropic") ||
    text.includes("meta") ||
    text.includes("microsoft")
  ) {
    return "labs";
  }

  if (
    text.includes("model") ||
    text.includes("gpt") ||
    text.includes("gemini") ||
    text.includes("claude") ||
    text.includes("llm")
  ) {
    return "model";
  }

  if (
    text.includes("framework") ||
    text.includes("sdk") ||
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
    text.includes("cursor") ||
    text.includes("workspace")
  ) {
    return "tool";
  }

  return "sector";
}

function buildFallbackRadar(items) {
  const date = new Date().toISOString().slice(0, 10);

  return {
    date,
    executive_title: "Radar IA del día",
    intro_message: "Resumen automático del ecosistema de IA.",
    opening_message:
      "Estas son las señales más relevantes detectadas hoy en herramientas, modelos y frameworks de IA.",
    items: items.slice(0, MAX_OUTPUT_ITEMS).map((i) => ({
      title: i.title || "",
      summary: i.summary || "",
      category: classifyCategory(i),
      source_name: i.source_name || "",
      source_url: i.source_url || "",
      relevance_score: Number(i.sector_score) || 7,
      status: "new",
      tags: [],
      what_changed: "Nueva señal detectada.",
      why_it_matters: "Puede impactar desarrollo, automatización o trabajo con IA.",
      sector_impact: "Relevante para el ecosistema de IA aplicada."
    }))
  };
}

async function buildRadarWithAI(items) {
  const prompt = `
Convierte estas notas reales en un radar diario de IA en español.

PRIORIZA FUERTEMENTE:
- herramientas
- modelos
- frameworks
- integraciones
- features nuevas
- Cursor
- ChatGPT
- Claude
- Gemini
- lanzamientos para developers
- automatización
- agentes

DESCARTA:
- política
- gobierno
- regulación
- comunicados institucionales
- investigación sin aplicación práctica
- notas generales sin utilidad operativa

Devuelve SOLO JSON válido con esta estructura:

{
  "executive_title":"string",
  "intro_message":"string",
  "opening_message":"string",
  "items":[
    {
      "title":"string",
      "summary":"string",
      "category":"labs | model | framework | tool | sector",
      "source_name":"string",
      "source_url":"string",
      "relevance_score":7,
      "status":"new",
      "tags":["string"],
      "what_changed":"string",
      "why_it_matters":"string",
      "sector_impact":"string"
    }
  ]
}

Máximo ${MAX_OUTPUT_ITEMS} items.

Notas:
${JSON.stringify(items.slice(0, MAX_INPUT_ITEMS), null, 2)}
`;

  const raw = await callOpenAI(prompt);
  if (!raw) return buildFallbackRadar(items);

  const parsed = JSON.parse(extractJson(raw));

  return {
    date: new Date().toISOString().slice(0, 10),
    executive_title: parsed.executive_title || "Radar IA del día",
    intro_message: parsed.intro_message || "Resumen automático del ecosistema de IA.",
    opening_message: parsed.opening_message || "Estas son las señales más relevantes detectadas hoy.",
    items: Array.isArray(parsed.items)
      ? parsed.items.slice(0, MAX_OUTPUT_ITEMS).map((i) => ({
          title: i.title || "",
          summary: i.summary || "",
          category: ["labs", "model", "framework", "tool", "sector"].includes(i.category)
            ? i.category
            : "tool",
          source_name: i.source_name || "",
          source_url: i.source_url || "",
          relevance_score: Number(i.relevance_score) || 7,
          status: i.status || "new",
          tags: Array.isArray(i.tags) ? i.tags : [],
          what_changed: i.what_changed || "",
          why_it_matters: i.why_it_matters || i.summary || "",
          sector_impact: i.sector_impact || ""
        }))
      : []
  };
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

  let items = await fetchFeedItems();
  console.log("Feed raw total:", items.length);

  items = filterRecent(items);
  console.log("Feed recent total:", items.length);

  items = filterRelevant(items);
  console.log("Feed relevant total:", items.length);

  items = uniqueNewItems(items, getHistoryLinks(history));
  console.log("Feed unique new total:", items.length);

  const radar = items.length
    ? await buildRadarWithAI(items)
    : {
        date: new Date().toISOString().slice(0, 10),
        executive_title: "Sin novedades relevantes",
        intro_message: "No se detectaron novedades nuevas con suficiente relevancia.",
        opening_message: "Hoy no aparecieron señales nuevas con suficiente peso para el radar.",
        items: []
      };

  saveJson(DAILY_FILE, radar);

  history.days.unshift({
    date: radar.date,
    executive_title: radar.executive_title,
    items: radar.items
  });

  history.days = history.days.slice(0, 7);
  saveJson(HISTORY_FILE, history);

  console.log("Radar ok:", radar.items.length, "items");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
