const STORAGE_KEY = 'aiAnswerScout.gemini.entries.v1';
const $ = (id) => document.getElementById(id);

const defaultTemplates = [
  'best {service} in {market}',
  'who offers {service} near {market}',
  '{service} cost in {market}',
  'what to check before hiring a {service} in {market}',
  'top rated {service} company in {market}',
  '{service} emergency help in {market}'
];

function getEntries() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}
function setEntries(entries) { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }
function lines(text) { return (text || '').split('\n').map(s => s.trim()).filter(Boolean); }
function splitList(text) { return Array.isArray(text) ? text : (text || '').split(',').map(s => s.trim()).filter(Boolean); }
function escapeHtml(str = '') {
  return String(str).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function truncate(text, n = 90) {
  if (!text) return '—';
  return String(text).length > n ? `${String(text).slice(0, n)}…` : String(text);
}

function normalizeTemplates(input, depth) {
  const custom = lines(input);
  const base = custom.length ? custom : defaultTemplates;
  const count = depth === 'fast' ? 2 : depth === 'deep' ? 6 : 4;
  return base.slice(0, count);
}

function calculateScore(data) {
  let score = 0;
  const businessCount = splitList(data.businesses).length;
  const sourceCount = splitList(data.sources).length;
  const answerType = data.answerType || '';
  const flags = data.flags || {};

  if (flags.weakAnswer) score += 18;
  if (flags.aggregators) score += 13;
  if (flags.localOperators) score += 11;
  if (flags.nationalBrands) score += 7;
  if (flags.preAction) score += 20;
  if (flags.buyerIntent) score += 16;
  if (businessCount === 0) score += 12;
  if (businessCount > 0 && businessCount <= 3) score += 8;
  if (sourceCount >= 2) score += 8;
  if (answerType === 'Generic advice') score += 8;
  if (answerType === 'Directory-heavy') score += 10;
  if (answerType === 'Hallucinated / suspicious') score += 12;
  if ((data.confidence || '').includes('Weak')) score += 7;
  if ((data.confidence || '').includes('Suspicious')) score += 10;
  return Math.min(100, score);
}

function makeQueries(service, markets, templates) {
  return markets.flatMap(market => templates.map(t => ({
    market,
    query: t.replaceAll('{service}', service).replaceAll('{market}', market)
  })));
}

async function runScout(e) {
  e.preventDefault();
  const project = $('project').value.trim();
  const service = $('service').value.trim();
  const markets = lines($('markets').value);
  const depth = $('depth').value;
  const mode = $('mode').value;
  const model = $('model').value.trim();
  const scoutProvider = $('scoutProvider').value;
  const notes = $('notes').value.trim();
  const templates = normalizeTemplates($('templates').value, depth);
  const queries = makeQueries(service, markets, templates);

  if (!queries.length) return;
  $('runBtn').disabled = true;
  $('runStatus').innerHTML = `<strong>Running ${queries.length} checks with ${scoutProvider === 'gemini-grounded' ? 'Gemini Grounded Search' : 'Gemini Fast Scout'}...</strong><br />Gemini is doing the boring part. If grounded mode complains, test Fast Scout first; billing gremlins are shy until deployment day.`;

  try {
    const res = await fetch('/.netlify/functions/scout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, service, markets, queries, mode, model, scoutProvider, notes })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Scout function failed.');

    const now = new Date().toISOString();
    const entries = (payload.entries || []).map(entry => {
      const normalized = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        createdAt: now,
        project,
        service,
        market: entry.market || '',
        query: entry.query || '',
        platform: payload.provider || 'Gemini scout',
        answerType: entry.answerType || 'Generic advice',
        confidence: entry.confidence || 'Medium / plausible',
        businesses: splitList(entry.businesses).join(', '),
        sources: splitList(entry.sources).join(', '),
        flags: entry.flags || {},
        opening: entry.opening || '',
        rawAnswer: entry.rawAnswer || entry.summary || '',
        summary: entry.summary || '',
        citations: entry.citations || []
      };
      normalized.score = Number.isFinite(entry.score) ? Math.max(0, Math.min(100, entry.score)) : calculateScore(normalized);
      return normalized;
    });

    if (!entries.length) throw new Error('The function returned no entries.');
    setEntries([...entries, ...getEntries()]);
    renderEntries();
    updateLatestRun(entries);
    $('runStatus').innerHTML = `<strong>Done.</strong> Saved ${entries.length} scout entries using ${escapeHtml(payload.provider || 'Gemini scout')}. Average score: ${average(entries.map(e => e.score))}/100.`;
  } catch (err) {
    $('runStatus').innerHTML = `<span class="error"><strong>Run failed:</strong> ${escapeHtml(err.message)}</span><br />Check Netlify environment variables and function logs. The most common issue is a missing BETO_SCOUT_PROVIDER_TOKEN or unsupported model. If Grounded Search failed, try Fast Scout first.`;
  } finally {
    $('runBtn').disabled = false;
  }
}

function average(nums) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a,b) => a + b, 0) / nums.length);
}

function updateLatestRun(entries) {
  const avg = average(entries.map(e => e.score));
  $('avgScore').textContent = avg;
  document.querySelector('.score-ring').style.setProperty('--score', `${avg}%`);
  let label = 'Low signal. Do not build from this alone.';
  let diag = 'The automated scout did not find a strong opening. Try narrower markets, more urgent query language, or a different service niche.';
  if (avg >= 75) {
    label = 'Strong opening. Worth a page/test.';
    diag = 'The batch shows weak or fragmented AI-answer behavior, useful source patterns, and enough buyer/pre-action signal to justify a focused test page or repo brief.';
  } else if (avg >= 50) {
    label = 'Promising. Validate one more pass.';
    diag = 'There are useful signals, but not enough to treat as locked. Run a second batch with tighter cities or alternate service wording.';
  } else if (avg >= 30) {
    label = 'Mild signal. Watch, do not chase.';
    diag = 'Some ingredients are present, but the niche is not screaming yet. The machine coughed politely, not prophetically.';
  }
  $('runLabel').textContent = label;
  $('runDiagnosis').innerHTML = `<p>${diag}</p>`;
}

function filteredEntries() {
  const term = $('searchEntries').value.toLowerCase().trim();
  const sort = $('sortEntries').value;
  let entries = getEntries();
  if (term) entries = entries.filter(e => JSON.stringify(e).toLowerCase().includes(term));
  entries.sort((a,b) => {
    if (sort === 'scoreDesc') return b.score - a.score;
    if (sort === 'scoreAsc') return a.score - b.score;
    if (sort === 'market') return (a.market || '').localeCompare(b.market || '');
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  return entries;
}

function scoreClass(score) {
  if (score >= 75) return 'score-high';
  if (score >= 50) return 'score-mid';
  return 'score-low';
}

function renderEntries() {
  const body = $('entriesBody');
  const entries = filteredEntries();
  body.innerHTML = '';
  $('emptyState').style.display = entries.length ? 'none' : 'block';
  entries.forEach(entry => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(entry.createdAt).toLocaleDateString()}</td>
      <td><strong>${escapeHtml(entry.project)}</strong></td>
      <td>${escapeHtml(entry.market)}</td>
      <td title="${escapeHtml(entry.query)}">${escapeHtml(truncate(entry.query, 95))}</td>
      <td>${escapeHtml(truncate(entry.businesses, 95))}</td>
      <td>${escapeHtml(truncate(entry.sources, 95))}</td>
      <td>${escapeHtml(entry.answerType)}</td>
      <td><span class="score-pill ${scoreClass(entry.score)}">${entry.score}</span></td>
      <td title="${escapeHtml(entry.opening)}">${escapeHtml(truncate(entry.opening, 115))}</td>
      <td><button class="delete-row" data-id="${entry.id}">Delete</button></td>
    `;
    body.appendChild(tr);
  });
}

function deleteEntry(id) {
  setEntries(getEntries().filter(e => e.id !== id));
  renderEntries();
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function exportCsv() {
  const entries = getEntries();
  const headers = ['createdAt','project','service','market','platform','query','answerType','confidence','businesses','sources','score','opening','summary','rawAnswer'];
  const rows = [headers.join(',')].concat(entries.map(e => headers.map(h => csvCell(e[h])).join(',')));
  download('ai-answer-scout-gemini.csv', rows.join('\n'), 'text/csv');
}
function csvCell(value) {
  const s = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}
function exportJson() {
  download('ai-answer-scout-gemini.json', JSON.stringify(getEntries(), null, 2), 'application/json');
}
function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('JSON must be an array of entries.');
      setEntries([...imported, ...getEntries()]);
      renderEntries();
      event.target.value = '';
    } catch (err) { alert(`Import failed: ${err.message}`); }
  };
  reader.readAsText(file);
}
function clearAll() {
  if (confirm('Clear all scout entries from this browser?')) {
    localStorage.removeItem(STORAGE_KEY);
    renderEntries();
    updateLatestRun([]);
  }
}
function resetRunner() {
  $('runnerForm').reset();
  $('runStatus').textContent = '';
}
function loadHotTub() {
  $('project').value = 'Hot tub removal';
  $('service').value = 'hot tub removal service';
  $('markets').value = 'Salt Lake City, UT\nDenver, CO\nBoise, ID';
  $('templates').value = defaultTemplates.slice(0, 4).join('\n');
  $('depth').value = 'standard';
  $('mode').value = 'pre-action-gap';
  $('scoutProvider').value = 'gemini-fast';
  $('notes').value = 'Use this for niche validation. Look for directory dependence, national-brand dominance, weak local specificity, and pre-action uncertainty: access, electrical disconnect, deck damage, haul-away limits, permits, and whether movers or junk removal fits the job.';
}

$('runnerForm').addEventListener('submit', runScout);
$('resetRunner').addEventListener('click', resetRunner);
$('loadHotTub').addEventListener('click', loadHotTub);
$('exportCsv').addEventListener('click', exportCsv);
$('exportJson').addEventListener('click', exportJson);
$('importJson').addEventListener('change', importJson);
$('clearAll').addEventListener('click', clearAll);
$('searchEntries').addEventListener('input', renderEntries);
$('sortEntries').addEventListener('change', renderEntries);
$('entriesBody').addEventListener('click', e => { if (e.target.matches('.delete-row')) deleteEntry(e.target.dataset.id); });

renderEntries();
