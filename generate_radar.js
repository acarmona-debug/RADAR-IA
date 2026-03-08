const fs = require("fs");
const Parser = require("rss-parser");
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const parser = new Parser({
  timeout: 15000
});

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";

const FEEDS = [
  { source: "OpenAI News", url: "https://openai.com/news/" },
  { source: "Google AI", url: "https://blog.google/technology/ai/rss/" },
  { source: "Anthropic News", url: "https://www.anthropic.com/news/rss.xml" },
  { source: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" }
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
      if (item.source_url) links.add(String(item.source_url).trim());
    }
  }
  return links;
}

function updateHistory(history, items, date) {
  const nextDays = Array.isArray(history.days) ? [...history.days] : [];

  nextDays.unshift({
    date,
    items: items.map(item => ({
      title: item.title,
      source_name: item.source_name || "",
      source_url: item.source_url || "",
      category: item.category || ""
    }))
  });

  return { days: nextDays.slice(0, 7) };
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchFeedItems() {
  const collected = [];

  for (const feed of FEEDS) {
    try {
      if (feed.url.endsWith("/news/")) {
        continue;
      }

      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        collected.push({
          source_name: feed.source,
          title: cleanText(item.title),
          source_url: item.link || item.guid || "",
          published_at: item.isoDate || item.pubDate || "",
          summary: cleanText(item.contentSnippet || item.content || "")
        });
      }
    } catch (err) {
      console.error(Feed error: ${feed.source}, err.message);
    }
  }

  return collected;
}

function filterRecent(items) {
  const now = new Date();
  const maxAgeMs = 1000 * 60 * 60 * 72;

  return items.filter(item => {
    if (!item.title || !item.source_url) return false;
    if (!item.published_at) return true;

    const d = new Date(item.published_at);
    if (Number.isNaN(d.getTime())) return true;

    return now - d <= maxAgeMs;
  });
}

async function run() {
  const history = loadHistory();
  const existingLinks = getHistoryLinks(history);

  let feedItems = await fetchFeedItems();
  feedItems = filterRecent(feedItems);

  const uniqueByLink = [];
  const seen = new Set();

  for (const item of feedItems) {
    const key = item.source_url.trim();
    if (!seen.has(key) && !existingLinks.has(key)) {
      seen.add(key);
      uniqueByLink.push(item);
    }
  }

  const limited = uniqueByLink.slice(0, 20);

  const prompt = `
Toma estas notas REALES y conviértelas en un radar diario de IA en español.

Reglas:
- No inventes noticias.
- No inventes links.
- Usa únicamente la información dada.
- Si algo no está claro, resume sin inventar detalles.
- Clasifica cada item en una sola categoría:
  labs | model | framework | tool | sector

Devuelve SOLO JSON válido con esta estructura:

{
  "intro_message": "string",
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
    .replace(/^json\s*/i, "")
    .replace(/^\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const raw = JSON.parse(cleanedContent);

  const date = new Date().toISOString().slice(0, 10);

  const items = Array.isArray(raw.items) ? raw.items : [];

  const cleaned = {
    date,
    intro_message: raw.intro_message || "Radar diario generado a partir de fuentes reales.",
    items: items.map(item => ({
      title: item.title || "",
      summary: item.summary || "",
      category: item.category || "tool",
      source_name: item.source_name || "",
      source_url: item.source_url || "",
      relevance_score: typeof item.relevance_score === "number" ? item.relevance_score : 7,
      status: item.status === "follow_up" ? "follow_up" : "new",
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
      what_changed: item.what_changed || "",
      why_it_matters: item.why_it_matters || "",
      sector_impact: item.sector_impact || ""
    }))
  };

  fs.writeFileSync(DAILY_FILE, JSON.stringify(cleaned, null, 2));

  const updatedHistory = updateHistory(history, cleaned.items, date);
  saveHistory(updatedHistory);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
