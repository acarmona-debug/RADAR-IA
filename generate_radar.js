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
  "agent","workflow","automation","enterprise","assistant","copilot",
  "framework","sdk","api","model","llm","tool","app","integration",
  "rag","developer","repo","github","productivity","ai"
];

const BLOCK_KEYWORDS = [
  "wildlife","biology","genomics","hospital","patient","healthcare",
  "agriculture","astronomy","particle physics"
];

function ensureJsonFile(path, fallback) {
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, JSON.stringify(fallback, null, 2));
  }
}

function loadJson(path, fallback) {
  ensureJsonFile(path, fallback);
  try {
    return JSON.parse(fs.readFileSync(path));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreItem(item) {
  const text = (item.title + " " + item.summary).toLowerCase();
  let score = 0;

  ALLOW_KEYWORDS.forEach(k => {
    if (text.includes(k)) score += 2;
  });

  BLOCK_KEYWORDS.forEach(k => {
    if (text.includes(k)) score -= 6;
  });
  const PRIORITY_TERMS = [
  "cursor", "cursor.sh",
  "chatgpt", "gpt", "gpt-4", "gpt-5",
  "claude", "anthropic",
  "gemini", "google ai", "google deepmind"
  ];
  
  PRIORITY_TERMS.forEach(k => {
    if (text.includes(k)) score += 5;
  });
  return score;
}

function filterRecent(items) {
  const now = Date.now();
  const maxAge = 96 * 60 * 60 * 1000;

  return items.filter(i => {
    if (!i.published_at) return true;
    const d = new Date(i.published_at);
    if (isNaN(d)) return true;
    return now - d.getTime() <= maxAge;
  });
}

function filterRelevant(items) {
  return items
    .map(i => ({ ...i, sector_score: scoreItem(i) }))
    .filter(i => i.sector_score >= 2)
    .sort((a, b) => b.sector_score - a.sector_score);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + " timeout")), ms)
    )
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

    const items = (parsed.items || []).map(i => ({
      source_name: feed.source,
      title: cleanText(i.title),
      source_url: i.link || i.guid || "",
      published_at: i.isoDate || i.pubDate || "",
      summary: cleanText(i.contentSnippet || i.content || "")
    }));

    console.log("Feed ok:", feed.source, items.length);
    return items;
  } catch (err) {
    console.log("Feed error:", feed.source);
    return [];
  }
}

async function fetchFeedItems() {
  const results = await Promise.all(FEEDS.map(fetchOneFeed));
  return results.flat();
}

function getApiKey() {
  return process.env.OPENAI_API_KEY || "";
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
    clearTimeout(timer);

    if (data.output_text) return data.output_text;

    if (Array.isArray(data.output)) {
      const parts = data.output
        .flatMap(o => o.content || [])
        .filter(c => c.type === "output_text")
        .map(c => c.text);
      return parts.join("\n");
    }

    return null;
  } catch {
    return null;
  }
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON not found");
  return text.slice(start, end + 1);
}

function buildFallbackRadar(items) {
  const date = new Date().toISOString().slice(0, 10);

  return {
    date,
    executive_title: "Radar IA del día",
    intro_message: "Resumen automático del ecosistema de IA.",
    opening_message:
      "Estas son las señales más relevantes detectadas hoy en herramientas, modelos y frameworks de IA.",
    items: items.slice(0, MAX_OUTPUT_ITEMS).map(i => ({
      title: i.title,
      summary: i.summary,
      category: "tool",
      source_name: i.source_name,
      source_url: i.source_url,
      relevance_score: 7,
      status: "new",
      tags: [],
      what_changed: "Nueva señal detectada.",
      why_it_matters: "Puede impactar desarrollo y automatización.",
      sector_impact: "Relevante para el ecosistema de IA aplicada."
    }))
  };
}

async function buildRadarWithAI(items) {
  const prompt = `
Convierte estas notas reales en un radar diario de IA.

Prioriza:
- herramientas
- modelos
- frameworks
- integraciones
- features nuevas

Descarta:
- política
- comunicados institucionales
- investigación sin aplicación práctica

Devuelve SOLO JSON con esta estructura:

{
 "executive_title":"string",
 "intro_message":"string",
 "opening_message":"string",
 "items":[]
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
      ? parsed.items.slice(0, MAX_OUTPUT_ITEMS).map(i => ({
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

async function run() {
  console.log("Radar start");

  const history = loadJson(HISTORY_FILE, { days: [] });

  let items = await fetchFeedItems();

  console.log("Feed raw total:", items.length);

  items = filterRecent(items);
  console.log("Feed recent total:", items.length);

  items = filterRelevant(items);
  console.log("Feed relevant total:", items.length);

  const radar = await buildRadarWithAI(items);

  saveJson(DAILY_FILE, radar);

  history.days.unshift({
    date: radar.date,
    items: radar.items
  });

  history.days = history.days.slice(0, 7);

  saveJson(HISTORY_FILE, history);

  console.log("Radar ok:", radar.items.length, "items");

  process.exit(0);
}

run();
