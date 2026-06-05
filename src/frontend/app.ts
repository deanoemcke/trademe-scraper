import { matchesFilters, computeFilterReason, type FrontendFilters, type FilterReason } from '../lib/filters';
import { canHandleUrl } from '../lib/recipes/matcher';
import type { Listing, ListingDetail } from '../lib/recipes/base';

// ── State ─────────────────────────────────────────────────────────────────────

interface ListingItem {
  data: Listing;
  deepSearched: boolean;
  filterReason: FilterReason | null;
  aiCheckedHash: number | null;
  aiFilterReason: string | null;
}

function promptHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h;
}

interface UrlCardState {
  el: HTMLElement;
  input: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  removeBtn: HTMLButtonElement;
  criteriaEl: HTMLElement;
  countEl: HTMLElement;
  cacheStatusEl: HTMLElement;
  statusEl: HTMLElement;
  searched: boolean;
  searchedUrl: string;
  searching: boolean;
  abortController: AbortController | null;
  listingUrls: string[];
}

let allListings: ListingItem[] = [];
let isDeepSearchRunning = false;
const listingsByUrl = new Map<string, ListingItem>();
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

const CANCEL_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function updateCardSearchBtn(state: UrlCardState): void {
  if (state.searching) {
    state.searchBtn.disabled = false;
    state.searchBtn.innerHTML = `${CANCEL_ICON} Cancel`;
    return;
  }
  const current = state.input.value.trim();
  const alreadySearched = state.searched && current === state.searchedUrl;
  state.searchBtn.disabled = isDeepSearchRunning || !canHandleUrl(current) || alreadySearched;
  state.searchBtn.innerHTML = `${SEARCH_ICON} Search`;
}

function setDeepSearchBusy(busy: boolean): void {
  isDeepSearchRunning = busy;
  for (const state of urlCardStates) updateCardSearchBtn(state);
  updateDeepBtn();
}

const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const DEEP_BTN_INNER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> Deep Search`;

function createUrlCard(): UrlCardState {
  const idx = urlCardStates.length;
  const card = document.createElement('div');
  card.className = 'card url-card';
  card.innerHTML = `
    <div class="card-label" style="display:flex;align-items:center">URL ${idx + 1}<span class="url-card-count"></span><button class="btn btn-ghost url-remove-btn hidden" style="margin-left:auto;padding:0.15rem 0.45rem;line-height:1" title="Remove">✕</button></div>
    <div class="url-row">
      <input type="url" class="url-input" placeholder="Paste search URL…" />
      <button class="btn btn-primary url-search-btn" disabled>${SEARCH_ICON} Search</button>
    </div>
    <div class="url-card-status hidden"></div>
    <div class="url-criteria hidden"><div class="criteria-grid"></div><div class="cache-status hidden"></div></div>
  `;
  el('urlCardsContainer').appendChild(card);

  const input = card.querySelector<HTMLInputElement>('.url-input')!;
  const searchBtn = card.querySelector<HTMLButtonElement>('.url-search-btn')!;
  const removeBtn = card.querySelector<HTMLButtonElement>('.url-remove-btn')!;
  const criteriaEl = card.querySelector<HTMLElement>('.url-criteria')!;
  const countEl = card.querySelector<HTMLElement>('.url-card-count')!;
  const cacheStatusEl = card.querySelector<HTMLElement>('.cache-status')!;
  const statusEl = card.querySelector<HTMLElement>('.url-card-status')!;

  const state: UrlCardState = { el: card, input, searchBtn, removeBtn, criteriaEl, countEl, cacheStatusEl, statusEl, searched: false, searchedUrl: '', searching: false, abortController: null, listingUrls: [] };
  urlCardStates.push(state);

  input.addEventListener('input', () => updateCardSearchBtn(state));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !searchBtn.disabled) searchUrlCard(state);
  });
  searchBtn.addEventListener('click', () => {
    if (state.searching) state.abortController?.abort();
    else searchUrlCard(state);
  });
  removeBtn.addEventListener('click', () => removeUrlCard(state));

  updateRemoveButtons();
  return state;
}

function resetAllResults(): void {
  allListings = [];
  listingsByUrl.clear();
  el('listingsContainer').innerHTML = '';
  el('resultCount').textContent = '0';
  el('resultsSection').classList.add('hidden');
  for (const s of urlCardStates) {
    s.listingUrls = [];
    s.searched = false;
    s.searchedUrl = '';
    s.countEl.textContent = '';
    s.criteriaEl.querySelector('.criteria-grid')!.innerHTML = '';
    s.criteriaEl.classList.add('hidden');
    s.cacheStatusEl.classList.add('hidden');
    s.cacheStatusEl.innerHTML = '';
    s.statusEl.classList.add('hidden');
    s.searching = false;
    s.input.readOnly = false;
    updateCardSearchBtn(s);
  }
  updateDeepBtn();
  updateAiFilterBtn();
}

function rebuildListings(): void {
  const seen = new Set<string>();
  allListings = [];
  for (const state of urlCardStates) {
    for (const url of state.listingUrls) {
      if (!seen.has(url) && listingsByUrl.has(url)) {
        seen.add(url);
        allListings.push(listingsByUrl.get(url)!);
      }
    }
  }
}

function updateRemoveButtons(): void {
  const show = urlCardStates.length > 1;
  for (const s of urlCardStates) s.removeBtn.classList.toggle('hidden', !show);
}

function resetCardForResearch(state: UrlCardState): void {
  const otherUrls = new Set(urlCardStates.flatMap(s => s === state ? [] : s.listingUrls));
  for (const url of state.listingUrls) {
    if (!otherUrls.has(url)) {
      document.getElementById(cardId(url))?.remove();
      listingsByUrl.delete(url);
    }
  }
  state.listingUrls = [];
  state.searched = false;
  state.searchedUrl = '';
  state.countEl.textContent = '';
  state.criteriaEl.querySelector('.criteria-grid')!.innerHTML = '';
  state.criteriaEl.classList.add('hidden');
  state.cacheStatusEl.classList.add('hidden');
  state.cacheStatusEl.innerHTML = '';
  state.statusEl.classList.add('hidden');
  state.input.readOnly = false;
  rebuildListings();
  if (allListings.length === 0) el('resultsSection').classList.add('hidden');
  updateDeepBtn();
}

function removeUrlCard(state: UrlCardState): void {
  const otherUrls = new Set(urlCardStates.flatMap(s => s === state ? [] : s.listingUrls));
  for (const url of state.listingUrls) {
    if (!otherUrls.has(url)) {
      document.getElementById(cardId(url))?.remove();
      listingsByUrl.delete(url);
    }
  }
  state.el.remove();
  urlCardStates.splice(urlCardStates.indexOf(state), 1);
  rebuildListings();
  if (allListings.length === 0) el('resultsSection').classList.add('hidden');
  updateRemoveButtons();
  applyClientFilters();
}

async function searchUrlCard(state: UrlCardState): Promise<void> {
  const url = state.input.value.trim();
  if (!canHandleUrl(url)) return;

  if (state.searched) resetCardForResearch(state);

  el('resultsSection').classList.remove('hidden');
  state.searching = true;
  state.abortController = new AbortController();
  updateCardSearchBtn(state);
  updateDeepBtn();
  setCardStatus(state, 'Fetching listings…');

  let totalFound = 0;
  let cachedAge = '';
  let searchError = false;
  let wasCancelled = false;
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
        state.listingUrls.push(listing.url);
        if (!listingsByUrl.has(listing.url)) {
          const item: ListingItem = { data: listing, deepSearched: false, filterReason: null, aiCheckedHash: null, aiFilterReason: null };
          listingsByUrl.set(listing.url, item);
          allListings.push(item);
          renderCard(listing);
          el('resultCount').textContent = String(allListings.length);
        }
      } else if (ev.type === 'error') {
        searchError = true;
        setCardStatus(state, ev.message as string, 'error');
      }
    }, state.abortController.signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      wasCancelled = true;
    } else {
      searchError = true;
      setCardStatus(state, (err as Error).message, 'error');
    }
  }

  state.abortController = null;
  state.searching = false;

  if (wasCancelled) {
    setCardStatus(state, `Cancelled — ${totalFound} listing${totalFound !== 1 ? 's' : ''} loaded`, 'success');
    updateCardSearchBtn(state);
    updateDeepBtn();
    if (allListings.length > 0) applyClientFilters();
    return;
  }

  state.searched = true;
  state.searchedUrl = url;
  state.input.readOnly = true;
  updateCardSearchBtn(state);

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
  updateDeepBtn();

  if (allListings.length > 0) {
    applyClientFilters();
  }
}

// ── Client-side filtering ─────────────────────────────────────────────────────

function applyClientFilters(): void {
  const filters = getFilters();
  let visible = 0;
  for (const item of allListings) {
    item.filterReason = computeFilterReason(item.data, filters);
    const show = item.filterReason === null && item.aiFilterReason === null;
    const card = document.getElementById(cardId(item.data.url));
    if (card) card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  el('resultCount').textContent = String(visible);
  updateDeepBtn();
  updateAiFilterBtn();
}

function updateDeepBtn(): void {
  const btn = el<HTMLButtonElement>('deepBtn');
  const hasUnscraped = allListings.some(item => !item.deepSearched && item.filterReason === null && item.aiFilterReason === null);
  btn.disabled = isDeepSearchRunning || urlCardStates.some(s => s.searching) || !hasUnscraped;

}

function updateAiFilterBtn(): void {
  const prompt = el<HTMLTextAreaElement>('aiFilter').value.trim();
  const btn = el<HTMLButtonElement>('applyAiFilterBtn');
  if (!prompt || allListings.length === 0) { btn.disabled = true; return; }
  const hash = promptHash(prompt);
  btn.disabled = allListings.every(item => item.aiCheckedHash === hash);
}

async function runAiFilter(): Promise<void> {
  const prompt = el<HTMLTextAreaElement>('aiFilter').value.trim();
  if (!prompt) return;
  const hash = promptHash(prompt);
  const toCheck = allListings.filter(item => item.aiCheckedHash !== hash);
  if (toCheck.length === 0) return;

  const btn = el<HTMLButtonElement>('applyAiFilterBtn');
  btn.disabled = true;
  btn.textContent = `Filtering ${toCheck.length}…`;

  try {
    const res = await fetch('/api/ai-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        listings: toCheck.map(item => ({
          url: item.data.url,
          title: item.data.title,
          price: item.data.price,
          location: item.data.location,
          description: item.data.description?.slice(0, 300) ?? '',
        })),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }

    const data = await res.json() as { results: Array<{ url: string; pass: boolean; reason: string | null }> };
    for (const result of data.results) {
      const item = listingsByUrl.get(result.url);
      if (item) {
        item.aiCheckedHash = hash;
        item.aiFilterReason = result.pass ? null : (result.reason ?? 'Filtered by AI');
      }
    }

    applyClientFilters();
  } catch (err) {
    setStatus((err as Error).message, 'error');
  } finally {
    btn.textContent = 'Apply AI Filter';
    updateAiFilterBtn();
  }
}

async function clearQuickSearchCache(): Promise<void> {
  await fetch('/api/cache/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'quick-search' }),
  }).catch(() => null);
  resetAllResults();
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

async function runDeepSearch(): Promise<void> {
  const toScrape = allListings
    .filter(item => !item.deepSearched && item.filterReason === null && item.aiFilterReason === null)
    .map(item => item.data);

  if (toScrape.length === 0) return;

  setDeepSearchBusy(true);
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
          item.aiCheckedHash = null;
        }
        enrichCard(ev.url as string, detail);

        if (item) {
          const card = document.getElementById(cardId(item.data.url));
          const wasVisible = card !== null && card.style.display !== 'none';
          item.filterReason = computeFilterReason(item.data, getFilters());
          if (wasVisible && item.filterReason !== null) {
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
    });
  } catch (err) {
    setStatus((err as Error).message, 'error');
  }

  setDeepSearchBusy(false);
  updateAiFilterBtn();
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

el<HTMLButtonElement>('deepBtn').addEventListener('click', () => runDeepSearch());


el<HTMLTextAreaElement>('aiFilter').addEventListener('input', updateAiFilterBtn);
el<HTMLButtonElement>('applyAiFilterBtn').addEventListener('click', () => runAiFilter());

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
