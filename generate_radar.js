import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const prompt = `
Genera un radar diario de IA en español.

Incluye solo novedades relevantes sobre:
- Google Labs
- Gemini
- OpenAI / ChatGPT
- Claude
- frameworks de agentes o automatización
- tools nuevas útiles para trabajo o automatización

Excluye política, regulación, hardware y rumores.

Devuelve SOLO JSON con esta estructura:

{
  "date": "YYYY-MM-DD",
  "intro_message": "mensaje corto",
  "items": [
    {
      "category": "labs | model | framework | tool | sector",
      "title": "string",
      "summary": "string",
      "source_name": "string",
      "source_url": "string"
    }
  ]
}

Máximo 12 items.
`;

async function run() {
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: prompt,
    max_output_tokens: 1200
  });

  const text = response.output_text;

  try {
    const json = JSON.parse(text);
    fs.writeFileSync("daily.json", JSON.stringify(json, null, 2));
    console.log("Radar actualizado");
  } catch (e) {
    console.error("Error parseando JSON:", text);
  }
}

run();
