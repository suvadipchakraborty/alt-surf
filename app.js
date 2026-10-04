/* ==========================================================================
   Alt-Surf: website discovery engine
   Vanilla ES6+, no build step.
   ========================================================================== */

/* ---------- Configuration ---------- */
const CONFIG = {
  rapidApiKey: '4b5e07f3b7mshf2a4404a417af94p168eb3jsne4eab8a39882',
  rapidApiHost: 'similarsitecheck.p.rapidapi.com',
  endpoint: 'https://similarsitecheck.p.rapidapi.com/similarsites',
  queryParam: 'url',                 // change here if the endpoint expects a different parameter name
  siteUrl: 'https://alt-surf.suvadipchakraborty.workers.dev/',
  requestTimeoutMs: 20000,
  cacheTtlMs: 24 * 60 * 60 * 1000,   // cache results for 24h to save API quota
  skeletonCount: 8,
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

/* ---------- API layer ---------- */
class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'rate-limit' | 'auth' | 'network' | 'timeout' | 'server' | 'empty'
  }
}

async function fetchSimilarSites(domain) {
  const url = `${CONFIG.endpoint}?${CONFIG.queryParam}=${encodeURIComponent(domain)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': CONFIG.rapidApiKey,
        'x-rapidapi-host': CONFIG.rapidApiHost,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('timeout', 'The request took too long.');
    throw new ApiError('network', 'Could not reach the server.');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) throw new ApiError('rate-limit', 'Rate limit reached.');
  if (response.status === 401 || response.status === 403) throw new ApiError('auth', 'API key rejected.');
  if (response.status === 404) throw new ApiError('empty', 'No data for this site.');
  if (!response.ok) throw new ApiError('server', `Server responded with ${response.status}.`);

  let json;
  try {
    json = await response.json();
  } catch {
    throw new ApiError('server', 'Unreadable response from the server.');
  }

  // Some RapidAPI APIs return 200 with an error message body.
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const msg = String(json.message || json.error || '').toLowerCase();
    if (msg.includes('too many requests') || msg.includes('rate limit') || msg.includes('quota')) {
      throw new ApiError('rate-limit', 'Rate limit reached.');
    }
    if (msg.includes('not subscribed') || msg.includes('invalid api key')) {
      throw new ApiError('auth', 'API key rejected.');
    }
  }

  if (typeof console !== 'undefined') console.debug('[Alt-Surf] raw response', json);
  return normalizeResponse(json, domain);
}

/* ---------- Response parsing (defensive: tolerates several JSON shapes) ---------- */
const LIST_KEYS = ['similar_sites', 'similarSites', 'similarsites', 'similar', 'sites', 'alternatives', 'results', 'data', 'items', 'response'];
const DOMAIN_KEYS = ['domain', 'url', 'site', 'website', 'host', 'link', 'name'];
const SCORE_KEYS = ['similarity', 'similarity_score', 'similarityScore', 'score', 'match', 'rating'];
const DESC_KEYS = ['description', 'desc', 'summary', 'title', 'about'];
const TAG_KEYS = ['category', 'categories', 'tags', 'topic', 'industry'];

const pick = (obj, keys) => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

/** Finds the list of sites inside an unknown JSON structure. */
function findSiteList(node, depth = 0) {
  if (node == null || depth > 4) return null;
  if (Array.isArray(node)) return node;
  if (typeof node !== 'object') return null;

  for (const key of LIST_KEYS) {
    if (key in node) {
      const found = findSiteList(node[key], depth + 1);
      if (found) return found;
    }
  }
  // Object keyed by domain: { "hulu.com": 0.9, "max.com": { ... } }
  const keys = Object.keys(node);
  if (keys.length && keys.every((k) => sanitizeDomain(k))) {
    return keys.map((k) => {
      const v = node[k];
      return v && typeof v === 'object' ? { domain: k, ...v } : { domain: k, score: v };
    });
  }
  // Last resort: first array-valued property
  for (const key of keys) {
    if (Array.isArray(node[key])) return node[key];
  }
  for (const key of keys) {
    const found = findSiteList(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeScore(raw) {
  if (raw === undefined) return null;
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.min(100, Math.round(pct));
}

function normalizeItem(item) {
  if (typeof item === 'string') {
    const domain = sanitizeDomain(item);
    return domain ? { domain, score: null, description: '', tags: [] } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const domain = sanitizeDomain(String(pick(item, DOMAIN_KEYS) ?? ''));
  if (!domain) return null;

  const rawTags = pick(item, TAG_KEYS);
  const tags = (Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 3);

  const description = pick(item, DESC_KEYS);
  return {
    domain,
    score: normalizeScore(pick(item, SCORE_KEYS)),
    description: typeof description === 'string' ? description.trim() : '',
    tags,
  };
}

function normalizeResponse(json, queryDomain) {
  const list = findSiteList(json);
  if (!list) return [];
  const seen = new Set([queryDomain]);
  const sites = [];
  for (const item of list) {
    const site = normalizeItem(item);
    if (!site || seen.has(site.domain)) continue;
    seen.add(site.domain);
    sites.push(site);
  }
  return sites;
}

/* ---------- Cache ---------- */
const cacheKey = (domain) => `altsurf:v1:${domain}`;

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

function renderSkeletons() {
  const grid = $('skeleton-grid');
  grid.replaceChildren();
  for (let i = 0; i < CONFIG.skeletonCount; i++) {
    grid.append(
      el('article', { class: 'card is-skeleton', 'aria-hidden': 'true' }, [
        el('div', { class: 'card-top' }, [
          el('span', { class: 'sk sk-logo' }),
          el('span', { class: 'sk sk-line w60' }),
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
  const tags = [];
  if (site.score !== null) tags.push(el('span', { class: 'tag', text: `${site.score}% similar` }));
  for (const t of site.tags) tags.push(el('span', { class: 'tag tag-plain', text: t }));

  const external = el('a', {
    class: 'btn btn-primary', href: `https://${site.domain}`,
    target: '_blank', rel: 'noopener noreferrer',
    'aria-label': `Visit ${site.domain} (opens in a new tab)`,
    text: 'Visit Site',
  });
  const explore = el('button', {
    class: 'btn btn-ghost', type: 'button', 'data-domain': site.domain,
    'aria-label': `Find alternatives to ${site.domain}`, text: 'Alternatives',
  });

  return el('article', { class: 'card', style: `--i:${index}` }, [
    el('div', { class: 'card-top' }, [buildLogo(site.domain), el('h3', { class: 'card-domain', text: site.domain })]),
    site.description ? el('p', { class: 'card-desc', text: site.description }) : null,
    tags.length ? el('div', { class: 'tags' }, tags) : null,
    site.score !== null
      ? el('div', { class: 'meter', 'aria-hidden': 'true' }, [el('span', { style: `width:${site.score}%` })])
      : null,
    el('div', { class: 'card-actions' }, [external, explore]),
  ]);
}

let current = { domain: '', sites: [] };

function renderResults(domain, sites) {
  current = { domain, sites };
  const name = prettyName(domain);

  $('results-favicon').src = faviconUrl(domain);
  $('results-heading').textContent = `${sites.length} alternative${sites.length === 1 ? '' : 's'} to ${domain}`;
  $('results-sub').textContent = `Sites similar to ${name}, ready to explore.`;

  const grid = $('results-grid');
  grid.replaceChildren(...sites.map(buildCard));
  document.title = `Alternatives to ${name}: Alt-Surf`;
  showView('results');
}

const ERROR_COPY = {
  'rate-limit': ['Search limit reached', 'The API has hit its request limit for now. Wait a minute and try again, or check your RapidAPI plan.', true],
  auth: ['API key problem', 'RapidAPI rejected the key. Check that the key is correct and subscribed to the Similarsitecheck API.', false],
  network: ['Can\u2019t reach the server', 'Check your internet connection and try again.', true],
  timeout: ['That took too long', 'The search timed out. Try again in a moment.', true],
  server: ['Something went wrong', 'The API returned an unexpected response. Try again shortly.', true],
};

function renderError(kind, domain) {
  if (kind === 'empty') {
    $('error-title').textContent = `No alternatives found for ${domain}`;
    $('error-text').textContent = 'The API has no similar sites for this one yet. Try a more popular website or check the spelling.';
    $('retry-btn').hidden = true;
  } else {
    const [title, text, canRetry] = ERROR_COPY[kind] || ERROR_COPY.server;
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    $('retry-btn').hidden = !canRetry;
  }
  showView('error');
}

/* ---------- Search flow ---------- */
let searchToken = 0;

async function search(rawInput, { pushUrl = true } = {}) {
  const domain = sanitizeDomain(rawInput);
  if (!domain) {
    showHint('That doesn\u2019t look like a website. Try something like netflix.com');
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
    renderResults(domain, cached);
    return;
  }

  renderSkeletons();
  showView('loading');

  try {
    const sites = await fetchSimilarSites(domain);
    if (token !== searchToken) return; // a newer search superseded this one
    if (!sites.length) return renderError('empty', domain);
    writeCache(domain, sites);
    renderResults(domain, sites);
  } catch (err) {
    if (token !== searchToken) return;
    renderError(err instanceof ApiError ? err.kind : 'server', domain);
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

// Deep links: https://.../?q=netflix.com
const initial = new URLSearchParams(location.search).get('q');
if (initial) search(initial, { pushUrl: false });
else showView('empty');
