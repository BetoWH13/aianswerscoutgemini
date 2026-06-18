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

    const entries = parsed.entries.map(entry =>
      normalizeEntry({
        entry,
        groundingSources,
        useGoogleSearch
      })
    );

    return json(200, {
      provider: useGoogleSearch ? 'Gemini grounded scout' : 'Gemini fast scout',
      model: selectedModel,
      requestedModel: requestedModel || null,
      grounded: useGoogleSearch,
      groundingSources,
      entries,
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
      temperature: 0.15,
      topP: 0.85,
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

function normalizeEntry({ entry, groundingSources, useGoogleSearch }) {
  const normalized = {
    market: safeString(entry.market),
    query: safeString(entry.query),
    answerType: safeString(entry.answerType),
    confidence: safeString(entry.confidence),
    businesses: toArray(entry.businesses),
    sources: toArray(entry.sources),
    citations: normalizeCitations(entry.citations, groundingSources, useGoogleSearch),
    flags: normalizeFlags(entry.flags),
    summary: safeString(entry.summary),
    opening: rewriteOpening(safeString(entry.opening), safeString(entry.query), safeString(entry.summary)),
    rawAnswer: safeString(entry.rawAnswer),
    score: clampScore(entry.score)
  };

  const adjusted = adjustScore(normalized, useGoogleSearch);

  normalized.score = adjusted.score;
  normalized.scoreRationale = adjusted.rationale.join(' | ');

  return normalized;
}

function normalizeFlags(flags = {}) {
  return {
    nationalBrands: Boolean(flags.nationalBrands),
    localOperators: Boolean(flags.localOperators),
    aggregators: Boolean(flags.aggregators),
    weakAnswer: Boolean(flags.weakAnswer),
    preAction: Boolean(flags.preAction),
    buyerIntent: Boolean(flags.buyerIntent)
  };
}

function normalizeCitations(citations, groundingSources, useGoogleSearch) {
  const fromEntry = toArray(citations).filter(Boolean);
  const realUrls = fromEntry.filter(x => /^https?:\/\//i.test(x));

  if (realUrls.length) return realUrls;

  if (Array.isArray(groundingSources) && groundingSources.length) return groundingSources;

  return [
    useGoogleSearch
      ? 'grounded search produced no usable citation'
      : 'fast scout mode: ungrounded pattern estimate'
  ];
}

function adjustScore(entry, useGoogleSearch) {
  let score = clampScore(entry.score);
  const rationale = [];

  const citationText = entry.citations.join(' ').toLowerCase();
  const hasRealCitation = entry.citations.some(x => /^https?:\/\//i.test(x));
  const weakCitation =
    citationText.includes('ungrounded') ||
    citationText.includes('unavailable') ||
    citationText.includes('weak') ||
    citationText.includes('no usable');

  const confidence = entry.confidence.toLowerCase();
  const answerType = entry.answerType.toLowerCase();
  const opening = entry.opening.toLowerCase();
  const summary = entry.summary.toLowerCase();

  if (!useGoogleSearch || !hasRealCitation || weakCitation) {
    score -= 14;
    rationale.push('citation penalty: ungrounded/weak evidence');
  }

  if (confidence.includes('weak') || confidence.includes('vague')) {
    score -= 10;
    rationale.push('confidence penalty: weak/vague');
  } else if (confidence.includes('medium') || confidence.includes('plausible')) {
    score -= 6;
    rationale.push('confidence penalty: plausible but not proven');
  } else if (confidence.includes('suspicious') || confidence.includes('hallucinated')) {
    score -= 22;
    rationale.push('confidence penalty: suspicious/hallucinated');
  }

  if (entry.flags.buyerIntent) {
    score += 8;
    rationale.push('buyer intent bonus');
  }

  if (entry.flags.aggregators) {
    score += 6;
    rationale.push('aggregator dependence bonus');
  }

  if (entry.flags.weakAnswer) {
    score += 8;
    rationale.push('weak answer bonus');
  }

  if (entry.flags.preAction) {
    score += 7;
    rationale.push('pre-action angle bonus');
  }

  if (entry.flags.nationalBrands && entry.flags.localOperators) {
    score += 4;
    rationale.push('mixed national/local field bonus');
  }

  if (answerType.includes('directory-heavy')) {
    score += 4;
    rationale.push('directory-heavy bonus');
  }

  if (looksLikeSalesCopy(opening)) {
    score -= 8;
    rationale.push('opening penalty: sales-copy wording');
  }

  if (summary.includes('limited deep analysis') || summary.includes('generic advice') || summary.includes('star ratings')) {
    score += 4;
    rationale.push('shallow-answer opportunity bonus');
  }

  if (!entry.businesses.length) {
    score -= 8;
    rationale.push('no named entities penalty');
  }

  const allFlagsTrue = Object.values(entry.flags).every(Boolean);
  if (allFlagsTrue && (!hasRealCitation || weakCitation)) {
    score -= 8;
    rationale.push('all-flags-true penalty without evidence');
  }

  score = clampScore(score);

  return {
    score,
    rationale
  };
}

function rewriteOpening(opening, query, summary) {
  if (!opening || looksLikeSalesCopy(opening)) {
    return [
      'Build a pre-call decision page, not a fake “best company” list.',
      'Focus on what makes this job harder than a normal pickup: access path, deck integration, electrical disconnect, water drainage, weight, cut-up/removal method, disposal rules, and when a junk hauler may not be enough.',
      'Use the page to help the visitor decide what to check before calling, then route the call.'
    ].join(' ');
  }

  return opening;
}

function looksLikeSalesCopy(text) {
  const t = String(text || '').toLowerCase();

  return (
    t.includes('we connect') ||
    t.includes('vetted') ||
    t.includes('top-rated') ||
    t.includes('hassle-free') ||
    t.includes('curated list') ||
    t.includes('our platform') ||
    t.includes('reliable local providers') ||
    t.includes('go beyond simple listings')
  );
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value.map(x => String(x).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,;\n]/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  return [];
}

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function clampScore(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 40;

  return Math.max(0, Math.min(100, Math.round(n)));
}

function buildPrompt({ project, service, queries, mode, notes, useGoogleSearch }) {
  return `Run a local AI-answer scout for niche validation. The user is a small niche-site / affiliate / lead-gen operator. The goal is market intelligence, not a SaaS sales report.

Be skeptical. Penalize unsupported certainty. Treat Fast Scout as pattern estimation, not proof. Do not invent exact citations or pretend live search was used. If you are not grounded, mark names and sources as likely patterns only.

Provider mode: ${
    useGoogleSearch
      ? 'Grounded Google Search is enabled. Use current web evidence where useful. Cite real URLs only when actually used. If grounding is thin, say so.'
      : 'Fast Scout mode. Live search is not available. Use market-pattern reasoning, entity recognition, and local SEO heuristics. Mark uncertainty honestly.'
  }

Project: ${project}
Service category: ${service}
Scout mode: ${mode || 'niche-validation'}
Operator notes: ${
    notes ||
    'Prioritize weak AI answers, directory dependence, national-brand dominance, local fragmentation, pre-action uncertainty, buyer/call intent, and whether a focused page can beat generic AI/local-pack mush.'
  }

For each query, infer the AI/web answer landscape. Do not write marketing copy. Do not say “we connect you with vetted providers.” We are not selling the visitor a SaaS report. We are deciding whether to build a niche page, router, or lead-gen test.

Queries:
${queries.map((q, i) => `${i + 1}. [${q.market}] ${q.query}`).join('\n')}

Return ONLY valid JSON. No markdown. No commentary. Start with { and end with }.

Schema:
{
  "batchSummary": "one concise paragraph describing the repeated pattern and whether this is worth further testing",
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
      "opening": "specific page/router opening for us, written as a strategic content angle, not sales copy",
      "rawAnswer": "compact reconstructed answer notes, not long prose",
      "score": 0
    }
  ]
}

Scoring guidance:
90-100 = rare. Strong buyer intent, clear weak answer pattern, fragmented local providers, directory dependence, pre-action uncertainty, and source-backed evidence.
75-89 = strong opening, but only if evidence is credible or the pattern is unusually clear.
55-74 = promising test candidate.
35-54 = mild signal only.
0-34 = weak, crowded, generic, or unsupported.

In Fast Scout mode, avoid scores above 74 unless the query has extremely clear buyer intent plus strong pre-action uncertainty. In Fast Scout mode, unsupported named businesses should not create high confidence.

Score higher for:
- clear buyer/call intent
- weak/generic AI answer pattern
- directory/aggregator dependence
- national brands overrepresented while local operators are fragmented
- a real pre-action decision angle
- user uncertainty before calling

Score lower for:
- unsupported names
- generic local-service conclusions
- fake precision
- “best company” pages with no unique decision layer
- sales-copy openings
- no buyer intent
- no pre-action uncertainty
- no useful content/router wedge`;
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
