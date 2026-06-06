import { matchesFilters, computeFilterReason, type FrontendFilters, type FilterReason } from '../lib/filters';
import { canHandleUrl } from '../lib/recipes/matcher';
import type { Listing, ListingDetail } from '../lib/recipes/base';

// ── State ─────────────────────────────────────────────────────────────────────

interface SavedSearch {
  id: string;
  name: string;
  urls: string[];
  filters: FrontendFilters;
  aiFilter: string | null;
  createdAt: number;
}

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
  searchId: string | null;
  cancellationRequested: boolean;
  listingUrls: string[];
}

let currentSearchName: string | null = null;
let allListings: ListingItem[] = [];
let showFilteredListings = false;
let isDeepSearchRunning = false;
let deepSearchId: string | null = null;
let deepSearchCancellationRequested = false;
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


function setFilters(f: FrontendFilters): void {
  el<HTMLInputElement>('minPrice').value = f.minPrice != null ? String(f.minPrice) : '';
  el<HTMLInputElement>('maxPrice').value = f.maxPrice != null ? String(f.maxPrice) : '';
  el<HTMLInputElement>('keywords').value = f.keywords?.join(', ') ?? '';
  el<HTMLInputElement>('excludeKeywords').value = f.excludeKeywords?.join(', ') ?? '';
  el<HTMLInputElement>('filterShipping').checked = f.shippingAvailable ?? true;
  el<HTMLInputElement>('filterPickup').checked = f.pickupAvailable ?? true;
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

function setSearchingStatus(state: UrlCardState, msg: string): void {
  const bar = state.statusEl;
  bar.className = 'url-card-status info';
  bar.innerHTML = `<span class="spinner"></span><span>${esc(msg)}</span>`;
  if (!state.cancellationRequested) {
    const btn = document.createElement('button');
    btn.className = 'cache-clear-btn';
    btn.style.marginLeft = '0.5rem';
    btn.textContent = 'cancel';
    btn.addEventListener('click', () => cancelSearch(state));
    bar.appendChild(btn);
  }
  bar.classList.remove('hidden');
}

function cancelSearch(state: UrlCardState): void {
  if (!state.searching || state.cancellationRequested) return;
  state.cancellationRequested = true;
  setSearchingStatus(state, 'Cancelling…');
  fetch('/api/cancel-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchId: state.searchId }),
  }).catch(() => null);
}

function setDeepSearchingStatus(msg: string): void {
  const bar = el('statusBar');
  bar.className = 'status-bar info';
  bar.innerHTML = `<span class="spinner"></span><span>${esc(msg)}</span>`;
  if (!deepSearchCancellationRequested) {
    const btn = document.createElement('button');
    btn.className = 'cache-clear-btn';
    btn.style.marginLeft = '0.5rem';
    btn.textContent = 'cancel';
    btn.addEventListener('click', cancelDeepSearch);
    bar.appendChild(btn);
  }
  bar.classList.remove('hidden');
}

function cancelDeepSearch(): void {
  if (!isDeepSearchRunning || deepSearchCancellationRequested) return;
  deepSearchCancellationRequested = true;
  setDeepSearchingStatus('Cancelling…');
  fetch('/api/cancel-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchId: deepSearchId }),
  }).catch(() => null);
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

function updateCardSearchBtn(state: UrlCardState): void {
  const current = state.input.value.trim();
  const alreadySearched = state.searched && current === state.searchedUrl;
  state.searchBtn.disabled = state.searching || isDeepSearchRunning || !canHandleUrl(current) || alreadySearched;
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

  const state: UrlCardState = { el: card, input, searchBtn, removeBtn, criteriaEl, countEl, cacheStatusEl, statusEl, searched: false, searchedUrl: '', searching: false, searchId: null, cancellationRequested: false, listingUrls: [] };
  urlCardStates.push(state);

  input.addEventListener('input', () => updateCardSearchBtn(state));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !searchBtn.disabled) searchUrlCard(state);
  });
  searchBtn.addEventListener('click', () => searchUrlCard(state));
  removeBtn.addEventListener('click', () => removeUrlCard(state));

  updateRemoveButtons();
  return state;
}

function resetAllResults(): void {
  allListings = [];
  listingsByUrl.clear();
  el('listingsContainer').innerHTML = '';
  el('resultCount').textContent = '0';
  showFilteredListings = false;
  el<HTMLButtonElement>('toggleFilteredBtn').textContent = 'show';
  el('filteredCount').classList.add('hidden');
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
    s.searchId = null;
    s.cancellationRequested = false;
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
  state.searchId = crypto.randomUUID();
  state.cancellationRequested = false;
  updateCardSearchBtn(state);
  updateDeepBtn();
  setSearchingStatus(state, 'Fetching listings…');

  let totalFound = 0;
  let cachedAge = '';
  let searchError = false;
  try {
    await streamPost('/api/quick-search', { url, searchId: state.searchId }, (ev) => {
      if (ev.type === 'criteria') {
        const filters = ev.filters as Array<[string, string]>;
        state.criteriaEl.querySelector('.criteria-grid')!.innerHTML = filters
          .map(([k, v]) => `<div class="criteria-row"><span class="criteria-key">${esc(k)}</span><span class="criteria-val">${esc(v)}</span></div>`)
          .join('');
        state.criteriaEl.classList.remove('hidden');
      } else if (ev.type === 'cached') {
        cachedAge = ev.age as string;
      } else if (ev.type === 'progress') {
        if (!state.cancellationRequested) setSearchingStatus(state, ev.message as string);
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
    });
  } catch (err) {
    searchError = true;
    setCardStatus(state, (err as Error).message, 'error');
  }

  state.searching = false;
  const wasCancelled = state.cancellationRequested;
  state.searchId = null;
  state.cancellationRequested = false;

  if (wasCancelled) {
    setCardStatus(state, `Cancelled — ${totalFound} listing${totalFound !== 1 ? 's' : ''} loaded`, 'error');
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

function filterBannerText(item: ListingItem): string {
  if (item.aiFilterReason) return `Filtered by AI: ${item.aiFilterReason}`;
  if (item.filterReason === 'keyword') return 'Filtered: does not match keyword criteria';
  if (item.filterReason === 'price') return 'Filtered: price out of range';
  if (item.filterReason === 'shipping') return 'Filtered: does not match shipping/pickup criteria';
  return 'Filtered';
}

function applyClientFilters(): void {
  const filters = getFilters();
  let visible = 0;
  let filtered = 0;
  for (const item of allListings) {
    item.filterReason = computeFilterReason(item.data, filters);
    const passes = item.filterReason === null && item.aiFilterReason === null;
    const card = document.getElementById(cardId(item.data.url));
    if (card) {
      const banner = card.querySelector<HTMLElement>('.filter-banner')!;
      if (passes) {
        card.style.display = '';
        card.classList.remove('filtered-out');
        banner.textContent = '';
        banner.classList.add('hidden');
        visible++;
      } else {
        filtered++;
        card.classList.add('filtered-out');
        banner.textContent = filterBannerText(item);
        banner.classList.remove('hidden');
        card.style.display = showFilteredListings ? '' : 'none';
      }
    }
  }
  el('resultCount').textContent = String(visible);
  const filteredCountEl = el('filteredCount');
  if (filtered > 0) {
    el('filteredCountNum').textContent = String(filtered);
    filteredCountEl.classList.remove('hidden');
  } else {
    filteredCountEl.classList.add('hidden');
  }
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

function updateDiscoveryBtn(): void {
  el<HTMLButtonElement>('discoveryBtn').disabled = !el<HTMLTextAreaElement>('discoveryPrompt').value.trim();
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
): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
    <div class="filter-banner hidden"></div>
    <div class="listing-card-content">
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

  deepSearchId = crypto.randomUUID();
  deepSearchCancellationRequested = false;
  setDeepSearchBusy(true);
  let hiddenByDescription = 0;
  let detailsReceived = 0;

  for (const listing of toScrape) {
    const card = document.getElementById(cardId(listing.url));
    if (card) {
      card.querySelector('.listing-extras')!.innerHTML =
        '<div style="padding-top:0.6rem">' +
        '<div class="skeleton" style="width:70%;margin-bottom:0.4rem"></div>' +
        '<div class="skeleton" style="width:40%"></div></div>';
    }
  }

  setDeepSearchingStatus(`Fetching details for ${toScrape.length} listing${toScrape.length !== 1 ? 's' : ''}…`);

  try {
    await streamPost('/api/deep-search', { listings: toScrape, deepSearchId }, (ev) => {
      if (ev.type === 'progress') {
        if (!deepSearchCancellationRequested) setDeepSearchingStatus(`Fetching details ${ev.index}/${ev.total} — ${String(ev.title).slice(0, 55)}…`);
      } else if (ev.type === 'detail') {
        detailsReceived++;
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
            const banner = card!.querySelector<HTMLElement>('.filter-banner')!;
            card!.classList.add('filtered-out');
            banner.textContent = filterBannerText(item);
            banner.classList.remove('hidden');
            if (!showFilteredListings) card!.style.display = 'none';
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

  // Clear skeleton loaders from listings that never received details
  for (const listing of toScrape) {
    const item = allListings.find(i => i.data.url === listing.url);
    if (item && !item.deepSearched) {
      const card = document.getElementById(cardId(listing.url));
      if (card) card.querySelector('.listing-extras')!.innerHTML = '';
    }
  }

  if (deepSearchCancellationRequested) {
    setStatus(`Cancelled — ${detailsReceived}/${toScrape.length} detail${toScrape.length !== 1 ? 's' : ''} loaded`, 'error');
  }

  deepSearchId = null;
  deepSearchCancellationRequested = false;
  setDeepSearchBusy(false);
  applyClientFilters();
}

function markDirty(): void {
  el('saveCurrentBtn').classList.remove('hidden');
}

function setSearchName(name: string | null): void {
  currentSearchName = name;
  el('searchTitle').textContent = name ?? 'new shiny thing';
  el('saveCurrentBtn').classList.add('hidden');
}

// ── Saved searches ────────────────────────────────────────────────────────────

async function fetchSavedSearches(): Promise<void> {
  try {
    const res = await fetch('/api/saved-searches', { cache: 'no-store' });
    const data = await res.json() as { searches: SavedSearch[] };
    renderSavedSearches(data.searches);
  } catch { /* non-critical */ }
}

function renderSavedSearches(searches: SavedSearch[]): void {
  const list = el('savedSearchesList');
  const count = el('savedSearchesCount');

  count.textContent = String(searches.length);
  count.classList.toggle('hidden', searches.length === 0);

  if (searches.length === 0) {
    list.innerHTML = '<p class="deep-empty">No saved searches yet.</p>';
    return;
  }
  list.innerHTML = searches.map(s => `
    <div class="saved-search-row" data-id="${esc(s.id)}">
      <a class="saved-search-name load-saved-btn" href="#" title="${esc(s.name)}">${esc(s.name)}</a>
      <span class="saved-search-date">${new Date(s.createdAt).toLocaleDateString()} ${new Date(s.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
      <button class="btn btn-ghost delete-saved-btn" style="padding:0.25rem 0.65rem;font-size:0.78rem">✕</button>
    </div>
  `).join('');
}

async function saveCurrentSearch(name: string): Promise<void> {
  const urls = urlCardStates.map(s => s.input.value.trim()).filter(Boolean);
  if (!name.trim() || urls.length === 0) return;
  const res = await fetch('/api/saved-searches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), urls, filters: getFilters(), aiFilter: el<HTMLTextAreaElement>('aiFilter').value.trim() || null }),
  });
  if (res.ok) await fetchSavedSearches();
}

async function deleteSavedSearch(id: string): Promise<void> {
  await fetch(`/api/saved-searches/${id}`, { method: 'DELETE' });
  await fetchSavedSearches();
}

async function loadSavedSearch(search: SavedSearch): Promise<void> {
  resetAllResults();
  while (urlCardStates.length > 1) removeUrlCard(urlCardStates[urlCardStates.length - 1]);
  if (search.urls.length === 0) return;
  urlCardStates[0].input.value = search.urls[0];
  updateCardSearchBtn(urlCardStates[0]);
  for (let i = 1; i < search.urls.length; i++) {
    const state = createUrlCard();
    state.input.value = search.urls[i];
    updateCardSearchBtn(state);
  }
  setFilters(search.filters);
  el<HTMLTextAreaElement>('aiFilter').value = search.aiFilter ?? '';
  setSearchName(search.name);
  el('savedSearchesPanel').classList.add('hidden');
  applyClientFilters();
  for (const state of urlCardStates) searchUrlCard(state);
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

el('toggleFilteredBtn').addEventListener('click', () => {
  showFilteredListings = !showFilteredListings;
  el<HTMLButtonElement>('toggleFilteredBtn').textContent = showFilteredListings ? 'hide' : 'show';
  for (const item of allListings) {
    if (item.filterReason !== null || item.aiFilterReason !== null) {
      const card = document.getElementById(cardId(item.data.url));
      if (card) card.style.display = showFilteredListings ? '' : 'none';
    }
  }
});


el<HTMLTextAreaElement>('discoveryPrompt').addEventListener('input', updateDiscoveryBtn);
el<HTMLButtonElement>('discoveryBtn').addEventListener('click', async () => {
  const prompt = el<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  if (!prompt) return;
  const btn = el<HTMLButtonElement>('discoveryBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    // TODO: implement discovery action
  } finally {
    btn.textContent = 'Give it to me!';
    updateDiscoveryBtn();
  }
});

el<HTMLTextAreaElement>('aiFilter').addEventListener('input', updateAiFilterBtn);
el<HTMLTextAreaElement>('aiFilter').addEventListener('input', markDirty);
el<HTMLButtonElement>('applyAiFilterBtn').addEventListener('click', () => runAiFilter());

(['minPrice', 'maxPrice', 'keywords', 'excludeKeywords'] as const).forEach(id => {
  el(id).addEventListener('input', applyClientFilters);
  el(id).addEventListener('input', markDirty);
});
(['filterShipping', 'filterPickup'] as const).forEach(id => {
  el(id).addEventListener('change', applyClientFilters);
  el(id).addEventListener('change', markDirty);
});

// Mark dirty on any URL input change or new URL card
el('urlCardsContainer').addEventListener('input', markDirty);
el('addUrlBtn').addEventListener('click', markDirty);

// Event delegation for description toggles (avoids global onclick)
el('listingsContainer').addEventListener('click', (e: MouseEvent) => {
  const showLessBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.extras-toggle');
  if (showLessBtn) { collapseExtras(showLessBtn); return; }
  const collapsedBody = (e.target as HTMLElement).closest<HTMLElement>('.extras-body.collapsed');
  if (collapsedBody) { expandExtras(collapsedBody); return; }
  const descBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.desc-toggle');
  if (descBtn) toggleDesc(descBtn);
});

// ── Saved searches UI ─────────────────────────────────────────────────────────

el('savedSearchesToggle').addEventListener('click', () => {
  const panel = el('savedSearchesPanel');
  const nowHidden = panel.classList.toggle('hidden');
  if (!nowHidden) fetchSavedSearches();
});

function openSaveModal(): void {
  el<HTMLInputElement>('saveSearchName').value = '';
  el('saveSearchModal').classList.remove('hidden');
  el<HTMLInputElement>('saveSearchName').focus();
}

function closeSaveModal(): void {
  el('saveSearchModal').classList.add('hidden');
}

el('saveCurrentBtn').addEventListener('click', openSaveModal);

el('saveSearchCancelBtn').addEventListener('click', closeSaveModal);

el('saveSearchModal').addEventListener('click', (e: MouseEvent) => {
  if (e.target === el('saveSearchModal')) closeSaveModal();
});

el('saveSearchConfirmBtn').addEventListener('click', async () => {
  const name = el<HTMLInputElement>('saveSearchName').value.trim();
  if (!name) return;
  const btn = el<HTMLButtonElement>('saveSearchConfirmBtn');
  btn.disabled = true;
  await saveCurrentSearch(name);
  setSearchName(name);
  closeSaveModal();
  btn.disabled = false;
  el('savedSearchesPanel').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

el<HTMLInputElement>('saveSearchName').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') el<HTMLButtonElement>('saveSearchConfirmBtn').click();
  if (e.key === 'Escape') closeSaveModal();
});

el('savedSearchesList').addEventListener('click', async (e: MouseEvent) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.saved-search-row');
  if (!row) return;
  const id = row.dataset.id!;
  if ((e.target as HTMLElement).closest('.delete-saved-btn')) {
    await deleteSavedSearch(id);
    return;
  }
  if ((e.target as HTMLElement).closest('.load-saved-btn')) {
    e.preventDefault();
    const res = await fetch(`/api/saved-searches/${id}`);
    if (!res.ok) return;
    const { search } = await res.json() as { search: SavedSearch };
    await loadSavedSearch(search);
  }
});
