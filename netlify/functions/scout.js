const SECRET_NAMES = [
  'BETO_SCOUT_PROVIDER_TOKEN',
  'AI_SCOUT_PROVIDER_TOKEN',
  'NOVA_SCOUT_PROVIDER_TOKEN',
  'GEMINI_API_KEY'
];

const MODEL_NAMES = [
  'BETO_SCOUT_MODEL',
  'AI_SCOUT_MODEL',
  'NOVA_SCOUT_MODEL',
  'GEMINI_MODEL'
];

const PREFERRED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview'
];

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = firstEnv(SECRET_NAMES);

  if (!apiKey) {
    return json(500, {
      error: 'Missing provider token environment variable.',
      fix: 'In Netlify, add BETO_SCOUT_PROVIDER_TOKEN under Site configuration > Environment variables, then clear-cache redeploy.'
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const { project, service, queries, mode, notes, model, scoutProvider } = body;

  if (!project || !service || !Array.isArray(queries) || !queries.length) {
    return json(400, { error: 'Missing project, service, or queries.' });
  }

  if (queries.length > 48) {
    return json(400, { error: 'Too many queries. Keep a run under 48 checks.' });
  }

  const requestedModel = cleanModelName(model || firstEnv(MODEL_NAMES) || '');
  const useGoogleSearch = scoutProvider === 'gemini-grounded';

  const prompt = buildPrompt({
    project,
    service,
    queries,
    mode,
    notes,
    useGoogleSearch
  });

  try {
    const selectedModel = await chooseUsableModel({
      apiKey,
      requestedModel
    });

    const data = await callGemini({
      apiKey,
      model: selectedModel,
      prompt,
      useGoogleSearch
    });

    const text = extractGeminiText(data);
    const parsed = parseJsonObject(text);

    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      return json(502, {
        error: 'Gemini returned invalid scout JSON.',
        raw: text,
        grounding: extractGroundingSources(data),
        model: selectedModel
      });
    }

    const groundingSources = extractGroundingSources(data);

    return json(200, {
      provider: useGoogleSearch ? 'Gemini grounded scout' : 'Gemini fast scout',
      model: selectedModel,
      requestedModel: requestedModel || null,
      grounded: useGoogleSearch,
      groundingSources,
      entries: parsed.entries.map(entry => ({
        ...entry,
        citations:
          Array.isArray(entry.citations) && entry.citations.length
            ? entry.citations
            : groundingSources
      })),
      batchSummary: parsed.batchSummary || ''
    });
  } catch (err) {
    return json(500, {
      error: err.message || 'Scout function crashed.',
      hint: useGoogleSearch
        ? 'If grounded mode fails, try Gemini Fast Scout first. Grounding with Google Search may require a supported model, quota, region, or billing setup.'
        : 'Check BETO_SCOUT_PROVIDER_TOKEN, remove unsupported BETO_SCOUT_MODEL values, and inspect Netlify function logs.',
      requestedModel: requestedModel || null
    });
  }
};

function firstEnv(names) {
  for (const name of names) {
    const value = (process.env[name] || '').trim();

    if (value) return value;
  }

  return '';
}

function cleanModelName(name) {
  return String(name || '').trim().replace(/^models\//, '');
}

async function chooseUsableModel({ apiKey, requestedModel }) {
  const models = await listModels(apiKey);

  const usable = models
    .filter(
      m =>
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes('generateContent')
    )
    .map(m => ({
      ...m,
      shortName: cleanModelName(m.name)
    }));

  if (!usable.length) {
    throw new Error(
      'Gemini API returned no models that support generateContent for this key. Open Google AI Studio and confirm the key is active.'
    );
  }

  if (requestedModel) {
    const exact = usable.find(m => m.shortName === requestedModel);

    if (exact) return exact.shortName;
  }

  for (const preferred of PREFERRED_MODELS) {
    const exact = usable.find(m => m.shortName === preferred);

    if (exact) return exact.shortName;
  }

  const flash = usable.find(
    m => /flash/i.test(m.shortName) && !/image|tts|live|embedding/i.test(m.shortName)
  );

  if (flash) return flash.shortName;

  const firstText = usable.find(m => !/image|tts|live|embedding/i.test(m.shortName));

  if (firstText) return firstText.shortName;

  return usable[0].shortName;
}

async function listModels(apiKey) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    method: 'GET',
    headers: {
      'x-goog-api-key': apiKey
    }
  });

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  let data;

  try {
    data = contentType.includes('application/json') ? JSON.parse(raw) : JSON.parse(raw);
  } catch {
    throw new Error(
      `Gemini ListModels returned non-JSON (${response.status}). First characters: ${raw.slice(
        0,
        80
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini ListModels error (${response.status}).`);
  }

  return Array.isArray(data.models) ? data.models : [];
}

async function callGemini({ apiKey, model, prompt, useGoogleSearch }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    }
  };

  if (useGoogleSearch) {
    payload.tools = [{ google_search: {} }];
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  let data;

  try {
    data = contentType.includes('application/json') ? JSON.parse(raw) : JSON.parse(raw);
  } catch {
    throw new Error(
      `Gemini returned non-JSON (${response.status}) for model ${model}. First characters: ${raw.slice(
        0,
        80
      )}`
    );
  }

  if (!response.ok) {
    const msg = data.error?.message || `Gemini API error (${response.status}) for model ${model}.`;
    throw new Error(msg);
  }

  return data;
}

function buildPrompt({ project, service, queries, mode, notes, useGoogleSearch }) {
  return `Run a local AI-answer scout for niche validation. The goal is not to sell a SaaS report. The goal is to extract market intelligence for a small niche-site / lead-gen operator deciding what to build.

Provider mode: ${
    useGoogleSearch
      ? 'Grounded Google Search is enabled. Use current web evidence where useful, but still mark uncertainty honestly.'
      : 'Fast scout mode. Do not pretend to have live evidence. Use market-pattern reasoning, entity recognition, and local SEO heuristics. Mark uncertainty honestly.'
  }
Project: ${project}
Service category: ${service}
Scout mode: ${mode || 'niche-validation'}
Operator notes: ${
    notes ||
    'Prioritize weak AI answers, directory dependence, national-brand dominance, local fragmentation, pre-action uncertainty, and buyer/call intent.'
  }

For each query below, infer what a consumer-facing AI/web answer would likely surface, then produce a structured record. Favor named entities, directories, sources, and observable patterns. Never claim proof of ranking. Never invent exact citations; if grounded search was unavailable or weak, say so in confidence/summary.

Queries:
${queries.map((q, i) => `${i + 1}. [${q.market}] ${q.query}`).join('\n')}

Return ONLY valid JSON. No markdown. No commentary. Start with { and end with }.

Schema:
{
  "batchSummary": "one concise paragraph",
  "entries": [
    {
      "market": "city/state",
      "query": "exact query",
      "answerType": "Named businesses | Generic advice | Directory-heavy | Map/local-pack style | Refusal / cannot answer | Hallucinated / suspicious",
      "confidence": "Strong / source-backed | Medium / plausible | Weak / vague | Suspicious / hallucinated",
      "businesses": ["named business 1", "named business 2"],
      "sources": ["source/citation/directory 1", "source/citation/directory 2"],
      "citations": ["https://example.com/source-if-actually-used"],
      "flags": {
        "nationalBrands": true,
        "localOperators": true,
        "aggregators": true,
        "weakAnswer": false,
        "preAction": true,
        "buyerIntent": true
      },
      "summary": "brief summary of what the answer landscape appears to show",
      "opening": "specific content/router/lead-gen opening for us",
      "rawAnswer": "compact reconstructed answer notes, not long prose",
      "score": 0
    }
  ]
}

Scoring guidance, 0-100:
75-100 = strong opening for a focused page/test.
50-74 = promising but needs another batch.
30-49 = mild signal only.
0-29 = weak or crowded/noisy.

Score higher when the query has clear buyer intent, visible local fragmentation, weak/generic answers, heavy directory/aggregator dependence, national brands overrepresented, local operators present but poorly differentiated, and a strong pre-action decision angle. Score lower when the query is already well served by authoritative local sources, has no buyer intent, or produces no useful content/lead-gen opening.`;
}

function extractGeminiText(data) {
  const parts = [];

  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.text) parts.push(part.text);
    }
  }

  return parts.join('\n').trim();
}

function extractGroundingSources(data) {
  const seen = new Set();
  const sources = [];

  for (const candidate of data.candidates || []) {
    const chunks = candidate.groundingMetadata?.groundingChunks || [];

    for (const chunk of chunks) {
      const uri = chunk.web?.uri || chunk.retrievedContext?.uri;

      if (!uri || seen.has(uri)) continue;

      seen.add(uri);
      sources.push(uri);
    }
  }

  return sources;
}

function parseJsonObject(text) {
  if (!text) throw new Error('Gemini returned an empty response.');

  const cleaned = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);

    if (!match) throw new Error('No JSON object found in Gemini output.');

    return JSON.parse(match[0]);
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: statusCode === 204 ? '' : JSON.stringify(body)
  };
}
