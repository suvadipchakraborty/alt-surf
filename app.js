/* ==========================================================================
   Alt-Surf: website discovery engine (powered by Google Gemini)
   Vanilla ES6+, no build step.
   ========================================================================== */

/* ---------- Configuration ---------- */
const CONFIG = {
  // >>> GEMINI API KEY: paste/replace your key here. <<<
  // This is a static site, so the key is visible to visitors. In Google AI Studio / Cloud Console,
  // restrict it to your site's HTTP referrer and to the Generative Language API only.
  GEMINI_API_KEY: 'AQ.Ab8RN6KJPYrgyvXWPApXQbipAr2yu9jUKgl0D3WW1SD21IgtNA',

  // Tried in order. If a model is retired (404) the next one is used automatically.
  // gemini-1.5-flash has been shut down by Google, so it is not used.
  MODELS: ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'],
  API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',

  RESULT_COUNT: 6,
  parseRetries: 1,                    // automatic re-asks when the AI returns unreadable JSON
  requestTimeoutMs: 30000,
  cacheTtlMs: 24 * 60 * 60 * 1000,    // reuse results for 24h (faster, saves quota)
  skeletonCount: 6,
  statusMessages: ['Analyzing competitors\u2026', 'Finding better options\u2026', 'Comparing the alternatives\u2026', 'Picking the best ones\u2026'],

  siteUrl: 'https://alt-surf.suvadipchakraborty.workers.dev/',
};

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);

const DOMAIN_RE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/**
 * Strips any user input down to a bare domain.
 * "https://www.google.com/search?q=x" -> "google.com"
 * Returns '' when the input does not look like a domain.
 */
function sanitizeDomain(input) {
  if (typeof input !== 'string') return '';
  let s = input.trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');  // protocol
  s = s.replace(/^\/\//, '');
  s = s.split(/[/?#\s]/)[0];                      // path, query, hash
  s = s.replace(/^.*@/, '');                      // credentials
  s = s.replace(/:\d+$/, '');                     // port
  s = s.replace(/^www\d?\./, '');                 // www.
  s = s.replace(/\.+$/, '');                      // trailing dots
  return DOMAIN_RE.test(s) ? s : '';
}

const faviconUrl = (domain) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

/** "netflix.com" -> "Netflix", "bbc.co.uk" -> "Bbc" */
function prettyName(domain) {
  const first = domain.split('.')[0] || domain;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Tiny safe DOM builder (never uses innerHTML with data). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

/* ---------- Gemini engine (LLM as a database) ---------- */
class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'rate-limit' | 'auth' | 'network' | 'timeout' | 'server' | 'parse' | 'blocked' | 'empty'
  }
}

function buildPrompt(domain) {
  return `Return a list of ${CONFIG.RESULT_COUNT} alternative websites to ${domain}. ` +
    `You must respond ONLY with a valid JSON array of objects. Do not include markdown formatting or code blocks. ` +
    `Each object must have these exact keys: 'name' (string, the site name), 'domain' (string, just the domain name like example.com), ` +
    `and 'reason' (string, a punchy 1-sentence explanation of why it is a good alternative).`;
}

const SYSTEM_INSTRUCTION =
  'You are Alt-Surf, a careful website recommender. Only recommend real, currently operating websites. ' +
  'Never include the site the user asked about. Output strictly valid JSON and nothing else.';

async function callGemini(model, domain) {
  const key = CONFIG.GEMINI_API_KEY;
  if (!key || /YOUR_|PASTE_/i.test(key)) {
    throw new ApiError('auth', 'Missing Gemini API key.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

  let response;
  try {
    response = await fetch(`${CONFIG.API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: buildPrompt(domain) }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('timeout', 'The request took too long.');
    throw new ApiError('network', 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = {};
    try { detail = (await response.json()).error || {}; } catch { /* ignore */ }
    const text = `${detail.status || ''} ${detail.message || ''}`.toLowerCase();
    if (response.status === 404) throw new ApiError('model-missing', `Model ${model} unavailable.`);
    if (response.status === 429 || text.includes('resource_exhausted') || text.includes('quota')) throw new ApiError('rate-limit', 'Rate limit reached.');
    if (response.status === 401 || response.status === 403 || text.includes('api key') || text.includes('api_key')) throw new ApiError('auth', 'API key rejected.');
    if (typeof console !== 'undefined') console.warn('[Alt-Surf] Gemini error', response.status, detail);
    throw new ApiError('server', `Server responded with ${response.status}.`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError('parse', 'Unreadable response from the server.');
  }

  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new ApiError('blocked', 'The request was blocked.');
  }
  const candidate = data.candidates && data.candidates[0];
  if (!candidate) throw new ApiError('parse', 'No answer returned.');

  const text = ((candidate.content && candidate.content.parts) || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!text.trim()) {
    throw new ApiError(candidate.finishReason === 'SAFETY' ? 'blocked' : 'parse', 'Empty answer.');
  }
  return text;
}

/** Turns the model's text into a clean array of {name, domain, reason}. Throws ApiError('parse') on garbage. */
function parseSites(text, queryDomain) {
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a === -1 || b <= a) throw new ApiError('parse', 'Not JSON.');
    try { parsed = JSON.parse(s.slice(a, b + 1)); } catch { throw new ApiError('parse', 'Not JSON.'); }
  }

  // Accept { "alternatives": [...] } style wrappers too.
  if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
    parsed = Object.values(parsed).find(Array.isArray);
  }
  if (!Array.isArray(parsed)) throw new ApiError('parse', 'Not an array.');

  const seen = new Set([queryDomain]);
  const sites = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const domain = sanitizeDomain(String(item.domain || ''));
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    sites.push({
      domain,
      name: String(item.name || prettyName(domain)).trim().slice(0, 60),
      reason: String(item.reason || '').trim().slice(0, 300),
    });
  }
  if (!sites.length) throw new ApiError('parse', 'No valid sites.');
  return sites;
}

async function fetchAlternatives(domain) {
  let lastError = new ApiError('server', 'Unknown error.');
  for (const model of CONFIG.MODELS) {
    for (let attempt = 0; attempt <= CONFIG.parseRetries; attempt++) {
      try {
        const text = await callGemini(model, domain);
        if (typeof console !== 'undefined') console.debug(`[Alt-Surf] ${model} raw output`, text);
        return parseSites(text, domain);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        lastError = err;
        if (err.kind === 'parse') continue;          // ask the same model once more
        if (err.kind === 'model-missing') break;      // try the next model
        throw err;                                    // auth, rate-limit, network, ...
      }
    }
  }
  throw lastError.kind === 'model-missing' ? new ApiError('server', 'No Gemini model available.') : lastError;
}

/* ---------- Cache ---------- */
const cacheKey = (domain) => `altsurf:v2:${domain}`;

function readCache(domain) {
  try {
    const raw = localStorage.getItem(cacheKey(domain));
    if (!raw) return null;
    const { t, sites } = JSON.parse(raw);
    if (Date.now() - t > CONFIG.cacheTtlMs || !Array.isArray(sites)) return null;
    return sites;
  } catch {
    return null;
  }
}

function writeCache(domain, sites) {
  try {
    localStorage.setItem(cacheKey(domain), JSON.stringify({ t: Date.now(), sites }));
  } catch { /* storage full or blocked: ignore */ }
}

/* ---------- Views ---------- */
const views = ['empty', 'loading', 'results', 'error'];
function showView(name) {
  for (const v of views) $(`view-${v}`).hidden = v !== name;
}

function showHint(message) {
  const hint = $('form-hint');
  hint.textContent = message || '';
  hint.hidden = !message;
}

function toast(message, ms = 3200) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, ms);
}

/* Pulsing status text while Gemini thinks */
let statusTimer = null;
function startStatus() {
  stopStatus();
  const node = $('status-text');
  let i = 0;
  node.textContent = CONFIG.statusMessages[0];
  statusTimer = setInterval(() => {
    i = (i + 1) % CONFIG.statusMessages.length;
    node.textContent = CONFIG.statusMessages[i];
  }, 1800);
}
function stopStatus() {
  clearInterval(statusTimer);
  statusTimer = null;
}

function renderSkeletons() {
  const grid = $('skeleton-grid');
  grid.replaceChildren();
  for (let i = 0; i < CONFIG.skeletonCount; i++) {
    grid.append(
      el('article', { class: 'card is-skeleton', 'aria-hidden': 'true' }, [
        el('div', { class: 'card-top' }, [
          el('span', { class: 'sk sk-logo' }),
          el('div', { class: 'sk-stack' }, [el('span', { class: 'sk sk-line w60' }), el('span', { class: 'sk sk-line w40' })]),
        ]),
        el('span', { class: 'sk sk-line w90' }),
        el('span', { class: 'sk sk-line w70' }),
        el('div', { class: 'card-actions' }, [el('span', { class: 'sk sk-btn' }), el('span', { class: 'sk sk-btn' })]),
      ])
    );
  }
}

function buildLogo(domain) {
  const img = el('img', {
    class: 'logo', src: faviconUrl(domain), alt: '',
    width: '56', height: '56', loading: 'lazy', decoding: 'async',
  });
  img.addEventListener('error', () => {
    img.replaceWith(el('span', { class: 'logo logo-fallback', 'aria-hidden': 'true', text: domain.charAt(0).toUpperCase() }));
  }, { once: true });
  return img;
}

function buildCard(site, index) {
  const external = el('a', {
    class: 'btn btn-primary', href: `https://${site.domain}`,
    target: '_blank', rel: 'noopener noreferrer',
    'aria-label': `Visit ${site.name} (opens in a new tab)`,
    text: 'Visit Site',
  });
  const explore = el('button', {
    class: 'btn btn-ghost', type: 'button', 'data-domain': site.domain,
    'aria-label': `Find alternatives to ${site.name}`, text: 'Alternatives',
  });

  return el('article', { class: 'card', style: `--i:${index}` }, [
    el('div', { class: 'card-top' }, [
      buildLogo(site.domain),
      el('div', { class: 'card-id' }, [
        el('h3', { class: 'card-domain', text: site.name }),
        el('p', { class: 'card-host', text: site.domain }),
      ]),
    ]),
    site.reason ? el('p', { class: 'card-reason', text: site.reason }) : null,
    el('div', { class: 'card-actions' }, [external, explore]),
  ]);
}

let current = { domain: '', sites: [] };

function renderResults(domain, sites) {
  current = { domain, sites };
  const name = prettyName(domain);

  $('results-favicon').src = faviconUrl(domain);
  $('results-heading').textContent = `${sites.length} alternative${sites.length === 1 ? '' : 's'} to ${domain}`;
  $('results-sub').textContent = 'Each pick comes with the reason it earns its spot.';

  $('results-grid').replaceChildren(...sites.map(buildCard));
  document.title = `Alternatives to ${name}: Alt-Surf`;
  showView('results');
}

const ERROR_COPY = {
  parse: ['The AI got its wires crossed', 'Gemini replied in a format we couldn\u2019t read. It happens now and then, so give it another go.', true],
  'rate-limit': ['Too many searches right now', 'The Gemini API hit its request limit. Wait a minute and try again.', true],
  auth: ['API key problem', 'Google rejected the Gemini API key. Check that it is correct, enabled for the Generative Language API, and allowed for this site\u2019s address.', false],
  network: ['Can\u2019t reach the server', 'Check your internet connection and try again.', true],
  timeout: ['That took too long', 'Gemini didn\u2019t answer in time. Try again in a moment.', true],
  blocked: ['No answer for that one', 'Gemini declined to suggest alternatives for this site. Try a different one.', false],
  server: ['Something went wrong', 'The Gemini API returned an unexpected error. Try again shortly.', true],
};

function renderError(kind) {
  const [title, text, canRetry] = ERROR_COPY[kind] || ERROR_COPY.server;
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('retry-btn').hidden = !canRetry;
  showView('error');
}

/* ---------- Search flow ---------- */
let searchToken = 0;

async function search(rawInput, { pushUrl = true } = {}) {
  const domain = sanitizeDomain(rawInput);
  if (!domain) {
    showHint('That doesn\u2019t look like a website. Try something like reddit.com');
    $('search-input').focus();
    return;
  }
  showHint('');

  const input = $('search-input');
  input.value = domain;
  input.blur();

  if (pushUrl) {
    const u = new URL(location.href);
    u.searchParams.set('q', domain);
    history.replaceState(null, '', u);
  }

  const token = ++searchToken;
  current.domain = domain;

  const cached = readCache(domain);
  if (cached && cached.length) {
    stopStatus();
    renderResults(domain, cached);
    return;
  }

  renderSkeletons();
  startStatus();
  showView('loading');

  try {
    const sites = await fetchAlternatives(domain);
    if (token !== searchToken) return; // a newer search superseded this one
    stopStatus();
    writeCache(domain, sites);
    renderResults(domain, sites);
  } catch (err) {
    if (token !== searchToken) return;
    stopStatus();
    renderError(err instanceof ApiError ? err.kind : 'server');
  }
}

/* ---------- Sharing ---------- */
async function shareResults() {
  if (!current.domain || !current.sites.length) return;
  const text = `I just found ${current.sites.length} great alternatives to ${prettyName(current.domain)} on Alt-Surf!`;
  const url = `${CONFIG.siteUrl}?q=${encodeURIComponent(current.domain)}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Alt-Surf', text, url });
    } catch (err) {
      if (err.name !== 'AbortError') toast('Sharing failed. Try again.');
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Link copied to clipboard');
  } catch {
    toast('Sharing isn\u2019t supported in this browser.');
  }
}

/* ---------- PWA: install prompt + service worker ---------- */
let deferredPrompt = null;
const installBtn = $('install-btn');

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if (isStandalone()) installBtn.hidden = true;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  installBtn.hidden = true;
  toast('Alt-Surf is saved to your device');
});

installBtn.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    return;
  }
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  toast(
    isIos
      ? 'Tap the Share button, then \u201cAdd to Home Screen\u201d.'
      : 'Open your browser menu and choose \u201cInstall app\u201d or \u201cAdd to Home Screen\u201d.',
    5000
  );
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
  });
}

/* ---------- Wiring ---------- */
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  search($('search-input').value);
});

$('search-input').addEventListener('input', () => showHint(''));

$('examples').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-domain]');
  if (btn) search(btn.dataset.domain);
});

$('results-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-domain]');
  if (!btn) return;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  search(btn.dataset.domain);
});

$('retry-btn').addEventListener('click', () => search(current.domain || $('search-input').value));
$('share-btn').addEventListener('click', shareResults);

// Deep links: https://.../?q=reddit.com
const initial = new URLSearchParams(location.search).get('q');
if (initial) search(initial, { pushUrl: false });
else showView('empty');
