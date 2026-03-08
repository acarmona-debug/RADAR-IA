const fs = require("fs");
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const HISTORY_FILE = "history.json";
const DAILY_FILE = "daily.json";

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function isDuplicate(history, title) {
  return history.some(h =>
    (h.title || "").toLowerCase().trim() ===
    (title || "").toLowerCase().trim()
  );
}

function updateHistory(history, items) {
  const today = new Date();

  const cleanedHistory = history.filter(item => {
    const diff =
      (today - new Date(item.date)) / (1000 * 60 * 60 * 24);
    return diff < 7;
  });

  const newEntries = items.map(item => ({
    title: item.title,
    date: today.toISOString()
  }));

  const updated = [...cleanedHistory, ...newEntries];
  saveHistory(updated);
}

async function run() {
  const history = loadHistory();

  const prompt = `
Genera un radar diario de novedades relevantes de IA.

Categorías posibles:
labs
model
framework
tool
sector

Enfocado en:
Google Labs
Gemini
ChatGPT / OpenAI
Claude / Anthropic
frameworks de agentes
tools nuevas de IA
IA aplicada a empresa

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
`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3
  });

  const content = response.choices[0].message.content;

  const raw = JSON.parse(content);

  const dedupedItems = (raw.items || []).filter(
    item => !isDuplicate(history, item.title)
  );

  const now = new Date();
  const date = now.toISOString().slice(0, 10);

  const cleaned = {
    date,
    intro_message:
      raw.intro_message ||
      "Resumen diario de novedades relevantes de IA.",
    items: dedupedItems
  };

  fs.writeFileSync(DAILY_FILE, JSON.stringify(cleaned, null, 2));

  updateHistory(history, dedupedItems);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
