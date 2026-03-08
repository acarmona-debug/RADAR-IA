const fs = require("fs");
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return { days: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));

    if (Array.isArray(raw)) {
      return {
        days: [
          {
            date: new Date().toISOString().slice(0, 10),
            items: raw
          }
        ]
      };
    }

    if (raw && Array.isArray(raw.days)) {
      return raw;
    }

    return { days: [] };
  } catch {
    return { days: [] };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function getHistoryTitles(history) {
  const titles = new Set();

  for (const day of history.days || []) {
    for (const item of day.items || []) {
      if (item && item.title) {
        titles.add(String(item.title).toLowerCase().trim());
      }
    }
  }

  return titles;
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

  const trimmed = nextDays.slice(0, 7);

  return { days: trimmed };
}

async function run() {
  const history = loadHistory();
  const existingTitles = getHistoryTitles(history);

  const prompt = `
Genera un radar diario de novedades relevantes de IA en español.

Categorías posibles:
labs
model
framework
tool
sector

Enfocado en:
- Google Labs
- Gemini
- ChatGPT / OpenAI
- Claude / Anthropic
- frameworks de agentes
- tools nuevas de IA
- IA aplicada a empresa

Devuelve JSON con esta estructura exacta:

{
  "intro_message": "mensaje corto tipo briefing",
  "items": [
    {
      "title": "",
      "summary": "",
      "category": "",
      "source_name": "",
      "source_url": "",
      "relevance_score": 0,
      "status": "new",
      "tags": [],
      "what_changed": "",
      "why_it_matters": "",
      "sector_impact": ""
    }
  ]
}

Máximo 8 items.
No agregues explicación.
No uses markdown.
`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3
  });

  const content = response.choices[0].message.content || "";

  const cleanedContent = content
    .replace(/^json\s*/i, "")
    .replace(/^\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const raw = JSON.parse(cleanedContent);

  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  const dedupedItems = rawItems.filter(item => {
    const title = String(item.title || "").toLowerCase().trim();
    return title && !existingTitles.has(title);
  });

  const date = new Date().toISOString().slice(0, 10);

  const cleaned = {
    date,
    intro_message:
      raw.intro_message || "Resumen diario de novedades relevantes de IA.",
    items: dedupedItems
  };

  fs.writeFileSync(DAILY_FILE, JSON.stringify(cleaned, null, 2));

  const updatedHistory = updateHistory(history, dedupedItems, date);
  saveHistory(updatedHistory);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
