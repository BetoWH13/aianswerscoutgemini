# AI Answer Scout Gemini

Automated local AI-answer scouting for niche validation, competitor discovery, and source mapping.

This version uses **Google AI Studio / Gemini API** through a **Netlify Function**. Your API key stays server-side. The browser never sees it.

## What it does

You enter:

- project / niche
- service category
- markets / cities
- optional query templates
- scout mode
- Gemini mode

Then the app:

1. Generates local buyer-intent queries.
2. Sends the batch to `/.netlify/functions/scout`.
3. Calls Gemini from the serverless function.
4. Extracts named businesses, sources/directories, weak-answer patterns, and content openings.
5. Scores each query from 0–100.
6. Saves results in browser localStorage.
7. Exports CSV/JSON.

## Gemini modes

### Gemini Fast Scout — free-tier friendly

Uses Gemini reasoning without requesting Google Search grounding. Best first test. Useful for quick niche screening and pattern detection.

### Gemini Grounded Search — stronger, may need billing/quota

Asks Gemini to use Google Search grounding. Better evidence, but it can require a supported model, available quota, allowed region, and/or billing depending on your account and current Google rules.

If grounded mode fails, switch to Fast Scout first.

## What it is for

Use it as an internal decision tool before building niche pages, lead-gen routers, or local-service content tests.

Good use cases:

- Hot tub removal
- Soot/smoke/fire cleanup pre-action pages
- Pool removal / pool fill-in decision pages
- Crawl space / ductwork / HVAC local-service research
- Any fragmented local service where AI answers may be weak, directory-heavy, or national-brand dominated

## What it is not

It is not a legally defensible rank tracker. It does not impersonate ChatGPT, Gemini, Perplexity, or Google AI Overviews. It does not prove that a business ranks in every user's AI answer.

Treat it as directional market intelligence.

## Deploy to Netlify

Use the **GitHub repo method** for this project because it includes a Netlify Function. Simple drag-and-drop is great for static pages, but functions are more reliable through Git/Netlify build deployment.

### GitHub repo method

1. Create a GitHub repo, for example `ai-answer-scout-gemini`.
2. Upload/push these files.
3. In Netlify, choose **Add new site → Import an existing project**.
4. Connect the repo.
5. Build command: leave blank, or use `npm install` only if Netlify asks.
6. Publish directory: `.`
7. Functions directory is already set in `netlify.toml`:

```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

8. Add this environment variable in Netlify:

```txt
GEMINI_API_KEY=your_api_key_here
```

Optional:

```txt
GEMINI_MODEL=gemini-2.5-flash
```

9. Redeploy.
10. Open the site and run a Fast Scout batch first.

## Get a Gemini API key

1. Open Google AI Studio.
2. Go to API keys.
3. Create or copy a Gemini API key.
4. Put it in Netlify as `GEMINI_API_KEY`.
5. Do **not** paste it into `app.js`, `index.html`, GitHub, or any browser-visible file.

## Local development

Install dependencies:

```bash
npm install
```

Create `.env` in the project root:

```txt
GEMINI_API_KEY=your_api_key_here
GEMINI_MODEL=gemini-2.5-flash
```

Run:

```bash
npm run dev
```

Open the local Netlify URL, usually `http://localhost:8888`.

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

## Troubleshooting

### “Missing GEMINI_API_KEY”

The key is not set in Netlify, or the site was not redeployed after adding it.

### Grounded Search fails

Use Fast Scout first. Grounding may require the right model, quota, billing, or region. The app is designed so Fast Scout remains usable even if grounding is not available.

### Function timeout or empty results

Run fewer cities or use Fast depth. Start with 2–3 markets and 2–4 queries per market.

## Security note

The Gemini API key belongs only in Netlify environment variables or a local `.env` file. Never commit keys to GitHub.
