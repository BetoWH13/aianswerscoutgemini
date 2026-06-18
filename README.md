# AI Answer Scout Gemini

Automated local AI-answer scouting for niche validation, competitor discovery, and source mapping.

This is an internal research aid, not a public SaaS. You enter a service niche, markets, and optional query templates. The app calls a Netlify Function, which calls Google Gemini server-side, extracts named businesses/sources/openings, scores the records, and saves them in browser localStorage.

## What it is for

Use it before building niche pages, lead-gen routers, or local-service content tests.

Good use cases:

- Hot tub removal
- Soot/smoke/fire cleanup pre-action pages
- Pool removal / pool fill-in decision pages
- Crawl space / ductwork / HVAC local-service research
- Any fragmented local service where AI answers may be weak, directory-heavy, or national-brand dominated

## What it is not

It is not a legally defensible rank tracker. It does not impersonate every platform. It does not prove that ChatGPT, Gemini, Perplexity, or Google will show the same answer to every user.

Treat outputs as directional market intelligence.

## Netlify environment variables

Use a custom variable name instead of the obvious generic key name.

Required:

```txt
BETO_SCOUT_PROVIDER_TOKEN=your_google_ai_studio_key_here
```

Optional:

```txt
BETO_SCOUT_MODEL=gemini-1.5-flash
```

The function also accepts these aliases if you need them later:

```txt
AI_SCOUT_PROVIDER_TOKEN
NOVA_SCOUT_PROVIDER_TOKEN
GEMINI_API_KEY       # legacy fallback only
AI_SCOUT_MODEL
NOVA_SCOUT_MODEL
GEMINI_MODEL         # legacy fallback only
```

Recommended first model while debugging:

```txt
gemini-1.5-flash
```

You can test newer models later after the basic flow works.

## Deploy to Netlify

1. Push this folder to GitHub.
2. In Netlify, import the GitHub repo.
3. Use these build settings:

```txt
Build command: leave blank
Publish directory: .
Functions directory: netlify/functions
```

4. Add the required environment variable:

```txt
BETO_SCOUT_PROVIDER_TOKEN=your_google_ai_studio_key_here
```

5. Optional but recommended while debugging:

```txt
BETO_SCOUT_MODEL=gemini-1.5-flash
```

6. Trigger:

```txt
Deploys → Trigger deploy → Clear cache and deploy site
```

## Quick function test

Open:

```txt
https://YOUR-SITE.netlify.app/.netlify/functions/scout
```

A working function should return JSON like:

```json
{"error":"Method not allowed","expected":"POST /.netlify/functions/scout"}
```

That is good. It means the serverless function exists.

## Workflow

1. Enter a project/niche, such as `Hot tub removal`.
2. Enter a service category, such as `hot tub removal service`.
3. Enter 2–8 markets, one per line.
4. Keep the default query templates or add your own using `{service}` and `{market}`.
5. Run the scout batch.
6. Sort by opportunity score.
7. Export CSV/JSON if you want to archive the evidence.

## Scoring logic

The opportunity score favors:

- weak/generic AI answers
- directory-heavy results
- aggregators like Yelp/Angi/HomeAdvisor
- local operators with poor differentiation
- national brands overrepresented
- clear buyer/call intent
- pre-action uncertainty angles

High score means: worth testing a focused page or repo skeleton.
Low score means: do not chase unless other signals are strong.

## Security notes

Your Google AI Studio key must stay server-side in Netlify environment variables. Do not put keys in `app.js`, `index.html`, GitHub README text, screenshots, or browser-visible files.

Preferred variable name:

```txt
BETO_SCOUT_PROVIDER_TOKEN
```

