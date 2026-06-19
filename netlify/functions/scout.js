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
  'gemini-2.0-flash-lite'
];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return json(204, {});
  }

  if (event.httpMethod !== 'POST') {
    return json(405, {
      error: 'Method not allowed',
      note: 'The scout function is deployed. Use the app UI to run POST requests.'
    });
  }

  const requiredAppPassword = String(process.env.BETO_SCOUT_APP_PASSWORD || '').trim();

  if (!requiredAppPassword) {
    return json(500, {
      error: 'Missing BETO_SCOUT_APP_PASSWORD.',
      fix: 'Add BETO_SCOUT_APP_PASSWORD in Netlify environment variables, then clear-cache redeploy.'
    });
  }

  const suppliedAppPassword = String(
    event.headers['x-scout-password'] ||
    event.headers['X-Scout-Password'] ||
    ''
  ).trim();

  if (suppliedAppPassword !== requiredAppPassword) {
    return json(401, {
      error: 'Private scout password required.'
    });
  }

  try {
    const apiKey = firstEnv(SECRET_NAMES);

    if (!apiKey) {
      return json(500, {
        error: 'Missing BETO_SCOUT_PROVIDER_TOKEN.',
        fix: 'Add BETO_SCOUT_PROVIDER_TOKEN in Netlify environment variables, then clear-cache redeploy.'
      });
    }

    const body = JSON.parse(event.body || '{}');
    const project = String(body.project || '').trim();
    const service = String(body.service || '').trim();
    const queries = Array.isArray(body.queries) ? body.queries : [];
    const mode = String(body.mode || 'niche-validation').trim();
    const notes = String(body.notes || '').trim();
    const scoutProvider = String(body.scoutProvider || 'gemini-fast').trim();
    const requestedModel = cleanModelName(body.model || firstEnv(MODEL_NAMES) || '');

    if (!project || !service || !queries.length) {
      return json(400, {
        error: 'Missing project, service, or queries.'
      });
    }

    if (queries.length > 48) {
      return json(400, {
        error: 'Too many queries. Keep one run under 48 checks.'
      });
    }

    const useGoogleSearch = scoutProvider === 'gemini-grounded';
    const selectedModel = await chooseModel(apiKey, requestedModel);

    const prompt = buildPrompt({
      project,
      service,
      queries,
      mode,
      notes,
      useGoogleSearch
    });

    const geminiData = await callGemini({
      apiKey,
      model: selectedModel,
      prompt,
      useGoogleSearch
    });

    const text = extractText(geminiData);
    const parsed = parseJson(text);

    if (!parsed || !Array.isArray(parsed.entries)) {
      return json(502, {
        error: 'Gemini returned text, but not the expected entries array.',
        raw: text,
        model: selectedModel
      });
    }

    const groundingSources = extractGroundingSources(geminiData);

    const entries = parsed.entries.map(entry =>
      normalizeEntry({
        entry,
        useGoogleSearch,
        groundingSources
      })
    );

    return json(200, {
      provider: useGoogleSearch ? 'Gemini grounded scout' : 'Gemini fast scout',
      model: selectedModel,
      grounded: useGoogleSearch,
      groundingSources,
      batchSummary: parsed.batchSummary || '',
      entries
    });
  } catch (error) {
    return json(500, {
      error: error.message || 'Scout function crashed.',
      hint: 'If this keeps failing, open Netlify > Functions > scout > Logs. Confirm BETO_SCOUT_PROVIDER_TOKEN exists, BETO_SCOUT_APP_PASSWORD exists, and BETO_SCOUT_MODEL is blank.'
    });
  }
};

function firstEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function cleanModelName(value) {
  return String(value || '').trim().replace(/^models\//, '');
}

async function chooseModel(apiKey, requestedModel) {
  const models = await listModels(apiKey);

  const usable = models
    .filter(model => {
      return (
        Array.isArray(model.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes('generateContent')
      );
    })
    .map(model => ({
      fullName: model.name,
      shortName: cleanModelName(model.name)
    }));

  if (!usable.length) {
    throw new Error('No Gemini models supporting generateContent were found for this API key.');
  }

  if (requestedModel) {
    const exact = usable.find(model => model.shortName === requestedModel);
    if (exact) return exact.shortName;
  }

  for (const preferred of PREFERRED_MODELS) {
    const exact = usable.find(model => model.shortName === preferred);
    if (exact) return exact.shortName;
  }

  const flash = usable.find(model => {
    return /flash/i.test(model.shortName) && !/image|tts|embedding|live/i.test(model.shortName);
  });

  if (flash) return flash.shortName;

  const textModel = usable.find(model => !/image|tts|embedding|live/i.test(model.shortName));

  return (textModel || usable[0]).shortName;
}

async function listModels(apiKey) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    method: 'GET',
    headers: {
      'x-goog-api-key': apiKey
    }
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini ListModels returned non-JSON. Status ${response.status}. First chars: ${raw.slice(0, 80)}`);
  }

  if (!response.ok) {
    throw new Error(data.error && data.error.message ? data.error.message : `Gemini ListModels error ${response.status}`);
  }

  return Array.isArray(data.models) ? data.models : [];
}

async function callGemini({ apiKey, model, prompt, useGoogleSearch }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const generationConfig = {
    temperature: useGoogleSearch ? 0.05 : 0.15,
    topP: 0.85,
    maxOutputTokens: 8192
  };

  /*
    Important:
    Gemini tool use / Google Search grounding currently does NOT support
    responseMimeType: "application/json".
    Fast Scout can use strict JSON mode.
    Grounded Scout must rely on prompt discipline + parseJson().
  */
  if (!useGoogleSearch) {
    generationConfig.responseMimeType = 'application/json';
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig
  };

  if (useGoogleSearch) {
    payload.tools = [{ google_search: {} }];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON. Status ${response.status}. First chars: ${raw.slice(0, 80)}`);
  }

  if (!response.ok) {
    throw new Error(data.error && data.error.message ? data.error.message : `Gemini API error ${response.status}`);
  }

  return data;
}

function buildPrompt({ project, service, queries, mode, notes, useGoogleSearch }) {
  const queryLines = queries
    .map((item, index) => {
      const market = item && item.market ? item.market : 'unknown market';
      const query = item && item.query ? item.query : '';
      return `${index + 1}. [${market}] ${query}`;
    })
    .join('\n');

  return `
Run a local AI-answer scout for niche validation.

This is an internal market intelligence tool for a niche-site / affiliate / lead-gen operator. It is not a SaaS sales report. Be skeptical. Penalize unsupported certainty. Do not write agency sales copy. Do not say “we connect you with vetted providers.”

Provider mode:
${useGoogleSearch ? 'Grounded Google Search requested. Use real evidence only when available. Cite real URLs only if actually used. Return valid JSON anyway, even though JSON mode is not enforced.' : 'Fast Scout mode. No live search. Treat results as pattern estimates, not proof.'}

Project:
${project}

Service category:
${service}

Scout mode:
${mode}

Operator notes:
${notes || 'Look for weak AI answers, directory dependence, local fragmentation, national-brand dominance, buyer intent, pre-action uncertainty, and focused page/router openings.'}

Queries:
${queryLines}

Return ONLY valid JSON. No markdown. No commentary. No code fence.

Schema:
{
  "batchSummary": "one concise paragraph",
  "entries": [
    {
      "market": "city/state",
      "query": "exact query",
      "answerType": "Named businesses | Generic advice | Directory-heavy | Map/local-pack style | Refusal / cannot answer | Hallucinated / suspicious",
      "confidence": "Strong / source-backed | Medium / plausible | Weak / vague | Suspicious / hallucinated",
      "businesses": ["business or entity names, if likely or observed"],
      "sources": ["likely or observed sources/directories"],
      "citations": ["real URL only if actually used"],
      "flags": {
        "nationalBrands": false,
        "localOperators": false,
        "aggregators": false,
        "weakAnswer": false,
        "preAction": false,
        "buyerIntent": false
      },
      "summary": "brief answer landscape summary",
      "opening": "strategic content/router opening for us, not sales copy",
      "rawAnswer": "compact reconstructed notes",
      "score": 0
    }
  ]
}

Scoring:
90-100 = rare. Strong evidence plus strong buyer intent plus clear weak answer plus strong pre-action/router wedge.
75-89 = strong, but only if evidence/pattern is unusually clear.
55-74 = promising test candidate.
35-54 = mild signal only.
0-34 = weak or unsupported.

In Fast Scout mode, avoid scores above 74 unless the pre-action decision angle is very strong. Unsupported named businesses should not create high confidence.

Good openings look like:
“Build a pre-call decision page explaining access path, deck integration, electrical disconnect, water drainage, disposal rules, and when a junk hauler may not be enough.”

Bad openings look like:
“We connect you with vetted top-rated local experts.”
`;
}

function extractText(data) {
  const parts = [];

  for (const candidate of data.candidates || []) {
    const contentParts = candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];

    for (const part of contentParts) {
      if (part.text) parts.push(part.text);
    }
  }

  return parts.join('\n').trim();
}

function extractGroundingSources(data) {
  const sources = [];
  const seen = new Set();

  for (const candidate of data.candidates || []) {
    const chunks =
      candidate.groundingMetadata && Array.isArray(candidate.groundingMetadata.groundingChunks)
        ? candidate.groundingMetadata.groundingChunks
        : [];

    for (const chunk of chunks) {
      const uri =
        (chunk.web && chunk.web.uri) ||
        (chunk.retrievedContext && chunk.retrievedContext.uri) ||
        '';

      if (uri && !seen.has(uri)) {
        seen.add(uri);
        sources.push(uri);
      }
    }
  }

  return sources;
}

function parseJson(text) {
  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  const cleaned = text
    .replace(/^```json/i, '')
    .replace(/^```/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('No JSON object found in Gemini response.');
    }
    return JSON.parse(match[0]);
  }
}

function normalizeEntry({ entry, useGoogleSearch, groundingSources }) {
  const flags = normalizeFlags(entry.flags);
  const citations = normalizeCitations(entry.citations, groundingSources, useGoogleSearch);
  const businesses = toArray(entry.businesses);
  const sources = toArray(entry.sources);

  const normalized = {
    market: stringValue(entry.market),
    query: stringValue(entry.query),
    answerType: stringValue(entry.answerType),
    confidence: stringValue(entry.confidence),
    businesses,
    sources,
    citations,
    flags,
    summary: stringValue(entry.summary),
    opening: cleanOpening(stringValue(entry.opening)),
    rawAnswer: stringValue(entry.rawAnswer),
    score: clamp(entry.score)
  };

  const adjusted = adjustScore(normalized, useGoogleSearch);
  normalized.score = adjusted.score;
  normalized.scoreRationale = adjusted.rationale.join(' | ');

  return normalized;
}

function normalizeFlags(flags) {
  const f = flags || {};
  return {
    nationalBrands: Boolean(f.nationalBrands),
    localOperators: Boolean(f.localOperators),
    aggregators: Boolean(f.aggregators),
    weakAnswer: Boolean(f.weakAnswer),
    preAction: Boolean(f.preAction),
    buyerIntent: Boolean(f.buyerIntent)
  };
}

function normalizeCitations(citations, groundingSources, useGoogleSearch) {
  const realUrls = toArray(citations).filter(item => /^https?:\/\//i.test(item));

  if (realUrls.length) return realUrls;

  if (Array.isArray(groundingSources) && groundingSources.length) return groundingSources;

  return [
    useGoogleSearch
      ? 'grounded search produced no usable citation'
      : 'fast scout mode: ungrounded pattern estimate'
  ];
}

function cleanOpening(opening) {
  const text = String(opening || '').trim();

  if (!text || looksLikeSalesCopy(text)) {
    return 'Build a pre-call decision page, not a fake best-company list. Focus on what makes this job harder than a normal pickup: access path, deck integration, electrical disconnect, water drainage, weight, cut-up/removal method, disposal rules, and when a junk hauler may not be enough.';
  }

  return text;
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
    t.includes('reliable local providers')
  );
}

function adjustScore(entry, useGoogleSearch) {
  let score = clamp(entry.score);
  const rationale = [];

  const hasRealCitation = entry.citations.some(item => /^https?:\/\//i.test(item));
  const confidence = entry.confidence.toLowerCase();

  if (!hasRealCitation) {
    score -= useGoogleSearch ? 8 : 14;
    rationale.push(useGoogleSearch ? 'grounded mode but no usable citation' : 'ungrounded evidence penalty');
  }

  if (confidence.includes('medium') || confidence.includes('plausible')) {
    score -= 6;
    rationale.push('medium confidence penalty');
  }

  if (confidence.includes('weak') || confidence.includes('vague')) {
    score -= 10;
    rationale.push('weak confidence penalty');
  }

  if (confidence.includes('suspicious') || confidence.includes('hallucinated')) {
    score -= 22;
    rationale.push('hallucination penalty');
  }

  if (entry.flags.buyerIntent) {
    score += 7;
    rationale.push('buyer intent');
  }

  if (entry.flags.aggregators) {
    score += 5;
    rationale.push('aggregator dependence');
  }

  if (entry.flags.weakAnswer) {
    score += 7;
    rationale.push('weak answer');
  }

  if (entry.flags.preAction) {
    score += 8;
    rationale.push('pre-action wedge');
  }

  if (entry.flags.nationalBrands && entry.flags.localOperators) {
    score += 3;
    rationale.push('mixed national/local field');
  }

  if (!entry.businesses.length) {
    score -= 8;
    rationale.push('no named entities');
  }

  if (Object.values(entry.flags).every(Boolean) && !hasRealCitation) {
    score -= 8;
    rationale.push('all flags true without citation penalty');
  }

  return {
    score: clamp(score),
    rationale
  };
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,;\n]/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function clamp(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return 45;

  return Math.max(0, Math.min(100, Math.round(number)));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Scout-Password',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: statusCode === 204 ? '' : JSON.stringify(body)
  };
}
