import { matchesFilters, type FrontendFilters } from '../lib/filters';
import { canHandleUrl } from '../lib/recipes/matcher';
import type { Listing, ListingDetail } from '../lib/recipes/base';

// ── State ─────────────────────────────────────────────────────────────────────

interface ListingItem {
  data: Listing;
  deepSearched: boolean;
}

interface UrlCardState {
  el: HTMLElement;
  input: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  criteriaEl: HTMLElement;
  countEl: HTMLElement;
  cacheStatusEl: HTMLElement;
  statusEl: HTMLElement;
  searched: boolean;
  searchedUrl: string;
}

let allListings: ListingItem[] = [];
let isRunning = false;
const seenUrls = new Set<string>();
const urlCardStates: UrlCardState[] = [];

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function getFilters(): FrontendFilters {
  const minP = el<HTMLInputElement>('minPrice').value;
  const maxP = el<HTMLInputElement>('maxPrice').value;
  const kw   = el<HTMLInputElement>('keywords').value.trim();
  const ex   = el<HTMLInputElement>('excludeKeywords').value.trim();
  return {
    minPrice: minP ? parseFloat(minP) : undefined,
    maxPrice: maxP ? parseFloat(maxP) : undefined,
    keywords: kw ? kw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    excludeKeywords: ex ? ex.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    shippingAvailable: el<HTMLInputElement>('filterShipping').checked,
    pickupAvailable:   el<HTMLInputElement>('filterPickup').checked,
  };
}


function setCardStatus(state: UrlCardState, msg: string | null, type: 'info' | 'success' | 'error' = 'info'): void {
  const bar = state.statusEl;
  if (!msg) { bar.classList.add('hidden'); return; }
  bar.className = `url-card-status ${type}`;
  bar.innerHTML = type === 'info'
    ? `<span class="spinner"></span><span>${esc(msg)}</span>`
    : `<span>${esc(msg)}</span>`;
  bar.classList.remove('hidden');
}

function setStatus(msg: string | null, type: 'info' | 'success' | 'error' = 'info'): void {
  const bar = el('statusBar');
  if (!msg) { bar.classList.add('hidden'); return; }
  bar.className = `status-bar ${type}`;
  bar.innerHTML = type === 'info'
    ? `<span class="spinner"></span><span>${esc(msg)}</span>`
    : `<span>${esc(msg)}</span>`;
  bar.classList.remove('hidden');
}

function setBusy(busy: boolean): void {
  isRunning = busy;
  for (const state of urlCardStates) {
    const current = state.input.value.trim();
    const alreadySearched = state.searched && current === state.searchedUrl;
    state.searchBtn.disabled = busy || !canHandleUrl(current) || alreadySearched;
  }
  updateDeepBtn();
}

const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const DEEP_BTN_INNER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Deep Search`;
const CANCEL_BTN_INNER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel Deep Search`;

function setDeepBtnCancelling(): void {
  const btn = el<HTMLButtonElement>('deepBtn');
  btn.innerHTML = CANCEL_BTN_INNER;
  btn.className = 'btn btn-danger';
  btn.disabled = false;
}

function restoreDeepBtn(): void {
  const btn = el<HTMLButtonElement>('deepBtn');
  btn.innerHTML = DEEP_BTN_INNER;
  btn.className = 'btn btn-secondary';
  updateDeepBtn();
}

function createUrlCard(): UrlCardState {
  const idx = urlCardStates.length;
  const card = document.createElement('div');
  card.className = 'card url-card';
  card.innerHTML = `
    <div class="card-label">URL ${idx + 1}<span class="url-card-count"></span></div>
    <div class="url-row">
      <input type="url" class="url-input" placeholder="Paste TradeMe search URL…" />
      <button class="btn btn-primary url-search-btn" disabled>${SEARCH_ICON} Search</button>
    </div>
    <div class="url-card-status hidden"></div>
    <div class="url-criteria hidden"><div class="criteria-grid"></div><div class="cache-status hidden"></div></div>
  `;
  el('urlCardsContainer').appendChild(card);

  const input = card.querySelector<HTMLInputElement>('.url-input')!;
  const searchBtn = card.querySelector<HTMLButtonElement>('.url-search-btn')!;
  const criteriaEl = card.querySelector<HTMLElement>('.url-criteria')!;
  const countEl = card.querySelector<HTMLElement>('.url-card-count')!;
  const cacheStatusEl = card.querySelector<HTMLElement>('.cache-status')!;
  const statusEl = card.querySelector<HTMLElement>('.url-card-status')!;

  const state: UrlCardState = { el: card, input, searchBtn, criteriaEl, countEl, cacheStatusEl, statusEl, searched: false, searchedUrl: '' };
  urlCardStates.push(state);

  input.addEventListener('input', () => {
    const current = input.value.trim();
    searchBtn.disabled = isRunning || !canHandleUrl(current) || (state.searched && current === state.searchedUrl);
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !searchBtn.disabled) searchUrlCard(state);
  });
  searchBtn.addEventListener('click', () => searchUrlCard(state));

  return state;
}

function resetAllResults(): void {
  allListings = [];
  seenUrls.clear();
  el('listingsContainer').innerHTML = '';
  el('resultCount').textContent = '0';
  el('resultsSection').classList.add('hidden');
  for (const s of urlCardStates) {
    s.searched = false;
    s.searchedUrl = '';
    s.countEl.textContent = '';
    s.criteriaEl.querySelector('.criteria-grid')!.innerHTML = '';
    s.criteriaEl.classList.add('hidden');
    s.cacheStatusEl.classList.add('hidden');
    s.cacheStatusEl.innerHTML = '';
    s.statusEl.classList.add('hidden');
    s.input.readOnly = false;
    s.searchBtn.disabled = !canHandleUrl(s.input.value.trim());
  }
  updateDeepBtn();
}

async function searchUrlCard(state: UrlCardState): Promise<void> {
  const url = state.input.value.trim();
  if (!canHandleUrl(url)) return;

  if (state.searched) resetAllResults();

  el('resultsSection').classList.remove('hidden');
  setBusy(true);
  setCardStatus(state, 'Fetching listings…');

  let totalFound = 0;
  let cachedAge = '';
  let searchError = false;
  try {
    await streamPost('/api/quick-search', { url }, (ev) => {
      if (ev.type === 'criteria') {
        const filters = ev.filters as Array<[string, string]>;
        state.criteriaEl.querySelector('.criteria-grid')!.innerHTML = filters
          .map(([k, v]) => `<div class="criteria-row"><span class="criteria-key">${esc(k)}</span><span class="criteria-val">${esc(v)}</span></div>`)
          .join('');
        state.criteriaEl.classList.remove('hidden');
      } else if (ev.type === 'cached') {
        cachedAge = ev.age as string;
      } else if (ev.type === 'progress') {
        setCardStatus(state, ev.message as string);
      } else if (ev.type === 'listing') {
        const listing = ev.data as Listing;
        totalFound++;
        if (seenUrls.has(listing.url)) return;
        seenUrls.add(listing.url);
        allListings.push({ data: listing, deepSearched: false });
        renderCard(listing);
        el('resultCount').textContent = String(allListings.length);
      } else if (ev.type === 'error') {
        searchError = true;
        setCardStatus(state, ev.message as string, 'error');
      }
    });
  } catch (err) {
    searchError = true;
    setCardStatus(state, (err as Error).message, 'error');
  }

  state.searched = true;
  state.searchedUrl = url;
  state.searchBtn.disabled = true;
  state.input.readOnly = true;

  if (cachedAge) {
    state.cacheStatusEl.innerHTML =
      `Loaded from cache — ${esc(cachedAge)} <button class="cache-clear-btn">Clear</button>`;
    state.cacheStatusEl.classList.remove('hidden');
    state.cacheStatusEl.querySelector('.cache-clear-btn')!.addEventListener('click', clearQuickSearchCache);
  }
  state.countEl.textContent = `— ${totalFound} listing${totalFound !== 1 ? 's' : ''}`;

  if (!searchError) {
    setCardStatus(state, `${totalFound} listing${totalFound !== 1 ? 's' : ''} found`, 'success');
  }
  setBusy(false);

  if (allListings.length > 0) {
    el('addUrlBtn').classList.remove('hidden');
    applyClientFilters();
  }
}

// ── Client-side filtering ─────────────────────────────────────────────────────

function applyClientFilters(): void {
  const filters = getFilters();
  let visible = 0;
  for (const item of allListings) {
    const show = matchesFilters(item.data, filters);
    const card = document.getElementById(cardId(item.data.url));
    if (card) card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  el('resultCount').textContent = String(visible);
  updateDeepBtn();
}

function updateDeepBtn(): void {
  const btn = el<HTMLButtonElement>('deepBtn');
  if (btn.classList.contains('btn-danger')) return; // in cancel mode — leave it alone
  const filters = getFilters();
  const hasUnscraped = allListings.some(
    item => !item.deepSearched && matchesFilters(item.data, filters)
  );
  btn.disabled = isRunning || !hasUnscraped;

  const hasDeepSearched = allListings.some(item => item.deepSearched);
  el('clearDeepCacheBtn').classList.toggle('hidden', !hasDeepSearched);
}

async function clearQuickSearchCache(): Promise<void> {
  await fetch('/api/cache/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'quick-search' }),
  }).catch(() => null);
  resetAllResults();
}

async function clearDeepSearchCache(): Promise<void> {
  await fetch('/api/cache/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'deep-search' }),
  }).catch(() => null);
  for (const item of allListings) item.deepSearched = false;
  updateDeepBtn();
}

// ── SSE streaming ─────────────────────────────────────────────────────────────

async function streamPost(
  endpoint: string,
  body: unknown,
  onData: (data: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { onData(JSON.parse(line.slice(6))); } catch { /* ignore */ }
      }
    }
  }
}

// ── Card helpers ──────────────────────────────────────────────────────────────

function cardId(url: string): string {
  const numId = url.match(/\/(?:listing|item)\/(\d+)/)?.[1];
  return 'card-' + (numId ?? url.replace(/[^a-zA-Z0-9]/g, '').slice(-20));
}

function shippingBadge(allowsPickups: number | undefined): string {
  if (allowsPickups === 1) return '<span class="badge badge-shipping">Shipping only</span>';
  if (allowsPickups === 2) return '<span class="badge badge-pickuponly">Pickup only</span>';
  if (allowsPickups === 3) return '<span class="badge badge-both">Allows pickups</span>';
  return '';
}

function reserveText(status: string): string {
  if (status === 'NONE') return 'No reserve';
  if (status === 'MET') return 'Reserve met';
  if (status === 'NOT_MET') return 'Reserve not met';
  return '';
}

function tidyDescription(text: string): string {
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderCard(listing: Listing): void {
  const id = cardId(listing.url);
  const card = document.createElement('div');
  card.className = 'listing-card';
  card.id = id;
  card.dataset.url = listing.url;
  card.dataset.isAuction = String(listing.isAuction ?? false);

  const thumb = listing.thumbnailUrl
    ? `<img class="listing-thumb" src="${esc(listing.thumbnailUrl)}" alt="" loading="lazy">`
    : `<div class="listing-thumb-placeholder">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
       </div>`;

  card.innerHTML = `
    ${thumb}
    <div class="listing-body">
      <div class="listing-title">
        <a href="${esc(listing.url)}" target="_blank" rel="noopener">${esc(listing.title)}</a>
      </div>
      <div class="listing-prices">
        <span class="price">${listing.price}</span>
      </div>
      <div class="listing-meta">
        <span class="meta-text">📍 ${esc(listing.location)}</span>
        ${shippingBadge(listing.allowsPickups)}
      </div>
      <div class="listing-extras"></div>
    </div>
  `;
  el('listingsContainer').appendChild(card);
}

function enrichCard(url: string, detail: ListingDetail): void {
  const card = document.getElementById(cardId(url));
  if (!card) return;
  card.classList.add('enriched');

  const isAuction = card.dataset.isAuction === 'true';

  const pricesEl = card.querySelector('.listing-prices')!;
  let pricesHtml = `<span class="price">${pricesEl.querySelector('.price')!.innerHTML}</span>`;
  if (isAuction && detail.buyNowPrice != null) {
    pricesHtml += `<span class="price-buynow">Buy Now: <strong>$${Number(detail.buyNowPrice).toLocaleString()}</strong></span>`;
  }
  pricesEl.innerHTML = pricesHtml;

  const metaEl = card.querySelector('.listing-meta')!;
  let metaHtml = `<span class="meta-text">📍 ${metaEl.querySelector('.meta-text')!.textContent!.slice(2)}</span>`;
  const { shippingAvailable, pickupAvailable } = detail;
  const hasDefiniteData = shippingAvailable !== null || pickupAvailable !== null;
  metaEl.querySelectorAll('.badge').forEach(b => {
    const isDeliveryBadge = b.classList.contains('badge-pickuponly') ||
                            b.classList.contains('badge-shipping') ||
                            b.classList.contains('badge-both');
    if (!isDeliveryBadge || !hasDefiniteData) metaHtml += b.outerHTML;
  });
  if (isAuction) {
    const reserve = reserveText(detail.reserveStatus);
    if (reserve) metaHtml += `<span class="badge badge-${detail.reserveStatus.toLowerCase().replace('_', '-')}">${esc(reserve)}</span>`;
  }
  if (hasDefiniteData) {
    if (shippingAvailable && pickupAvailable) {
      metaHtml += '<span class="badge badge-both">Shipping &amp; pickup</span>';
    } else if (shippingAvailable) {
      metaHtml += '<span class="badge badge-shipping">Shipping only</span>';
    } else if (pickupAvailable) {
      metaHtml += '<span class="badge badge-pickuponly">Pickup only</span>';
    }
  }
  metaEl.innerHTML = metaHtml;

  const extras = card.querySelector('.listing-extras')!;
  let body = '';

  // ── Details ───────────────────────────────────────────────────────────────
  if (detail.details.length > 0) {
    body += `<div class="deep-section">
      <div class="deep-section-label">Details</div>
      <div class="details-table">${detail.details.map(({ key, value }) =>
        `<span class="details-key">${esc(key)}</span><span class="details-val">${esc(value)}</span>`
      ).join('')}</div>
    </div>`;
  }

  // ── Description ───────────────────────────────────────────────────────────
  body += `<div class="deep-section"><div class="deep-section-label">Description</div>`;
  if (detail.description) {
    body += `<div class="listing-description">${esc(tidyDescription(detail.description))}</div>`;
  } else {
    body += `<p class="deep-empty">No description provided.</p>`;
  }
  body += `</div>`;

  // ── Questions & Answers ───────────────────────────────────────────────────
  if (detail.questionsAndAnswers.length > 0) {
    body += `<div class="deep-section"><div class="deep-section-label">Questions &amp; Answers</div>`;
    body += detail.questionsAndAnswers.map(({ question, answer }) =>
      `<div class="qa-pair">` +
      `<div class="qa-item"><span class="qa-badge qa-q">Q</span><span class="qa-text">${esc(question)}</span></div>` +
      (answer ? `<div class="qa-item"><span class="qa-badge qa-a">A</span><span class="qa-text">${esc(answer)}</span></div>` : '') +
      `</div>`
    ).join('');
    body += `</div>`;
  }

  extras.innerHTML = `<div class="extras-body collapsed">${body}<div class="extras-fade"></div></div><button class="extras-toggle" style="display:none">Show less</button>`;
}

function expandExtras(body: HTMLElement): void {
  body.classList.remove('collapsed');
  const btn = body.nextElementSibling as HTMLElement;
  if (btn) btn.style.display = '';
}

function collapseExtras(btn: HTMLButtonElement): void {
  const body = btn.previousElementSibling as HTMLElement;
  body.classList.add('collapsed');
  btn.style.display = 'none';
}

function toggleDesc(btn: HTMLButtonElement): void {
  const desc = btn.closest('.listing-description')!;
  const full  = desc.querySelector<HTMLElement>('.desc-full');
  const short = desc.querySelector<HTMLElement>('.desc-short');
  if (!full || !short) return;
  const expanded = full.classList.contains('open');
  full.classList.toggle('open', !expanded);
  short.classList.toggle('hidden', !expanded);
  btn.textContent = expanded ? 'Show more' : 'Show less';
}

// ── Search ────────────────────────────────────────────────────────────────────


// ── Deep Search ───────────────────────────────────────────────────────────────

let deepAbortController: AbortController | null = null;

async function runDeepSearch(): Promise<void> {
  const filters = getFilters();
  const toScrape = allListings
    .filter(item => !item.deepSearched && matchesFilters(item.data, filters))
    .map(item => item.data);

  if (toScrape.length === 0) return;

  deepAbortController = new AbortController();
  setDeepBtnCancelling();
  setBusy(true);
  let hiddenByDescription = 0;

  for (const listing of toScrape) {
    const card = document.getElementById(cardId(listing.url));
    if (card) {
      card.querySelector('.listing-extras')!.innerHTML =
        '<div style="padding-top:0.6rem">' +
        '<div class="skeleton" style="width:70%;margin-bottom:0.4rem"></div>' +
        '<div class="skeleton" style="width:40%"></div></div>';
    }
  }

  setStatus(`Fetching details for ${toScrape.length} listing${toScrape.length !== 1 ? 's' : ''}…`);

  try {
    await streamPost('/api/deep-search', { listings: toScrape }, (ev) => {
      if (ev.type === 'progress') {
        setStatus(`Fetching details ${ev.index}/${ev.total} — ${String(ev.title).slice(0, 55)}…`);
      } else if (ev.type === 'detail') {
        const detail = ev.detail as ListingDetail;
        const item = allListings.find(i => i.data.url === ev.url);
        if (item) {
          item.deepSearched = true;
          item.data.description = detail.description;
        }
        enrichCard(ev.url as string, detail);

        if (item) {
          const card = document.getElementById(cardId(item.data.url));
          const wasVisible = card !== null && card.style.display !== 'none';
          if (wasVisible && !matchesFilters(item.data, getFilters())) {
            card!.style.display = 'none';
            const current = parseInt(el('resultCount').textContent ?? '0', 10);
            el('resultCount').textContent = String(Math.max(0, current - 1));
            hiddenByDescription++;
          }
        }

        updateDeepBtn();
      } else if (ev.type === 'complete') {
        const msg = hiddenByDescription > 0
          ? `Deep search complete — ${hiddenByDescription} listing${hiddenByDescription !== 1 ? 's' : ''} hidden by description filter`
          : 'Deep search complete';
        setStatus(msg, hiddenByDescription > 0 ? 'info' : 'success');
        setTimeout(() => setStatus(null), 4000);
      } else if (ev.type === 'error') {
        setStatus(ev.message as string, 'error');
      }
    }, deepAbortController.signal);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      setStatus((err as Error).message, 'error');
    }
  } finally {
    deepAbortController = null;
    restoreDeepBtn();
  }

  setBusy(false);
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Initialise with the first URL card and focus its input
const firstCard = createUrlCard();
firstCard.input.focus();

el('addUrlBtn').addEventListener('click', () => {
  const newCard = createUrlCard();
  newCard.input.focus();
  newCard.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

el<HTMLButtonElement>('deepBtn').addEventListener('click', () => {
  if (deepAbortController) deepAbortController.abort();
  else runDeepSearch();
});

el<HTMLButtonElement>('clearDeepCacheBtn').addEventListener('click', clearDeepSearchCache);

(['minPrice', 'maxPrice', 'keywords', 'excludeKeywords'] as const).forEach(id => {
  el(id).addEventListener('input', applyClientFilters);
});
(['filterShipping', 'filterPickup'] as const).forEach(id => {
  el(id).addEventListener('change', applyClientFilters);
});

// Event delegation for description toggles (avoids global onclick)
el('listingsContainer').addEventListener('click', (e: MouseEvent) => {
  const showLessBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.extras-toggle');
  if (showLessBtn) { collapseExtras(showLessBtn); return; }
  const collapsedBody = (e.target as HTMLElement).closest<HTMLElement>('.extras-body.collapsed');
  if (collapsedBody) { expandExtras(collapsedBody); return; }
  const descBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.desc-toggle');
  if (descBtn) toggleDesc(descBtn);
});
