import { computeFilterReason, type FrontendFilters } from '../lib/filters';
import { canHandleUrl } from '../lib/recipes/matcher';
import type { Listing, ListingDetail } from '../lib/recipes/base';
import { esc } from './html';
import { sourceFaviconHtml } from './recipeDisplay';
import {
  type ListingItem,
  type UrlCardState,
  type SavedSearch,
  listingsByUrl,
  urlCardStates,
  cardIdByUrl,
  currentSearchName,
  showFilteredListings,
  isDeepSearchRunning,
  deepSearchId,
  deepSearchCancellationRequested,
  setCurrentSearchName,
  setShowFilteredListings,
  setIsDeepSearchRunning,
  setDeepSearchId,
  setDeepSearchCancellationRequested,
} from './state';

// ── Utility ───────────────────────────────────────────────────────────────────

function promptHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
  return h;
}


function el<T extends HTMLElement>(id: string): T {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Element #${id} not found`);
  return elem as T;
}

function getFilters(overrides?: Partial<FrontendFilters>): FrontendFilters {
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
    ...overrides,
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
  setDeepSearchCancellationRequested(true);
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
  setIsDeepSearchRunning(busy);
  for (const state of urlCardStates) updateCardSearchBtn(state);
  renderDerived();
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
  listingsByUrl.clear();
  el('listingsContainer').innerHTML = '';
  el('resultCount').textContent = '0';
  setShowFilteredListings(false);
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
  renderDerived();
}

function getOrderedListings(): ListingItem[] {
  const seen = new Set<string>();
  return urlCardStates
    .flatMap(s => s.listingUrls.filter(u => !seen.has(u) && seen.add(u)))
    .map(u => listingsByUrl.get(u)!)
    .filter(Boolean);
}

function renderDerived(): void {
  const listings = getOrderedListings();
  const visible = listings.filter(i => i.filterReason === null && i.aiFilterReason === null);
  const filtered = listings.length - visible.length;
  el('resultCount').textContent = String(visible.length);
  el('filteredCountNum').textContent = String(filtered);
  el('filteredCount').classList.toggle('hidden', filtered === 0);
  const isSearching = urlCardStates.some(s => s.searching);
  const hasUnscraped = visible.some(i => !i.deepSearched);
  el<HTMLButtonElement>('deepBtn').disabled = isDeepSearchRunning || isSearching || !hasUnscraped;
  const prompt = el<HTMLTextAreaElement>('aiFilter').value.trim();
  const hash = promptHash(prompt);
  el<HTMLButtonElement>('applyAiFilterBtn').disabled =
    !prompt || listings.length === 0 || listings.every(i => i.aiCheckedHash === hash);
}

function updateRemoveButtons(): void {
  const show = urlCardStates.length > 1;
  for (const s of urlCardStates) s.removeBtn.classList.toggle('hidden', !show);
}

function resetCardForResearch(state: UrlCardState): void {
  const otherUrls = new Set(urlCardStates.flatMap(s => s === state ? [] : s.listingUrls));
  for (const url of state.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
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
  if (getOrderedListings().length === 0) el('resultsSection').classList.add('hidden');
  renderDerived();
}

function removeUrlCard(state: UrlCardState): void {
  const otherUrls = new Set(urlCardStates.flatMap(s => s === state ? [] : s.listingUrls));
  for (const url of state.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
    }
  }
  state.el.remove();
  const idx = urlCardStates.indexOf(state);
  if (idx !== -1) urlCardStates.splice(idx, 1);
  if (getOrderedListings().length === 0) el('resultsSection').classList.add('hidden');
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
  renderDerived();
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
          const item: ListingItem = { data: listing, detail: null, deepSearched: false, filterReason: null, aiCheckedHash: null, aiFilterReason: null };
          listingsByUrl.set(listing.url, item);
          renderCard(item);
          renderDerived();
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
    if (listingsByUrl.size > 0) applyClientFilters();
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
  if (listingsByUrl.size > 0) {
    applyClientFilters();
  } else {
    renderDerived();
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
  for (const item of getOrderedListings()) {
    item.filterReason = computeFilterReason(item.data, filters);
    const passes = item.filterReason === null && item.aiFilterReason === null;
    const card = getCardByUrl(item.data.url);
    if (card) {
      const banner = card.querySelector<HTMLElement>('.filter-banner')!;
      if (passes) {
        card.style.display = '';
        card.classList.remove('filtered-out');
        banner.textContent = '';
        banner.classList.add('hidden');
      } else {
        card.classList.add('filtered-out');
        banner.textContent = filterBannerText(item);
        banner.classList.remove('hidden');
        card.style.display = showFilteredListings ? '' : 'none';
      }
    }
  }
  renderDerived();
}

function updateDiscoveryBtn(): void {
  const hasPrompt = !!el<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  const maxPriceRaw = el<HTMLInputElement>('discoveryMaxPrice').value.trim();
  const hasValidPrice = maxPriceRaw !== '' && isFinite(parseFloat(maxPriceRaw)) && parseFloat(maxPriceRaw) > 0;
  const isPickupOnly = el<HTMLSelectElement>('discoveryFulfillment').value === 'pickup';
  const hasRegion = !isPickupOnly || !!el<HTMLSelectElement>('discoveryRegion').value;
  el<HTMLButtonElement>('discoveryBtn').disabled = !hasPrompt || !hasValidPrice || !hasRegion;
}

async function runAiFilter(): Promise<void> {
  const prompt = el<HTMLTextAreaElement>('aiFilter').value.trim();
  if (!prompt) return;
  const hash = promptHash(prompt);
  const toCheck = getOrderedListings().filter(item => item.aiCheckedHash !== hash && item.filterReason === null);
  if (toCheck.length === 0) return;

  const btn = el<HTMLButtonElement>('applyAiFilterBtn');
  btn.disabled = true;
  let checked = 0;
  btn.textContent = `Filtering 0/${toCheck.length}…`;

  let streamError: string | null = null;

  try {
    await streamPost('/api/ai-filter', {
      prompt,
      listings: toCheck.map(item => ({
        url: item.data.url,
        title: item.data.title,
        price: item.data.priceDisplay,
        location: item.data.location,
        description: item.data.description?.slice(0, 300) ?? '',
      })),
    }, (event) => {
      if (event.type === 'result') {
        for (const result of event.results as Array<{ url: string; pass: boolean; reason: string | null }>) {
          const item = listingsByUrl.get(result.url);
          if (item) {
            item.aiCheckedHash = hash;
            item.aiFilterReason = result.pass ? null : (result.reason ?? 'Filtered by AI');
            checked++;
          }
        }
        btn.textContent = `Filtering ${checked}/${toCheck.length}…`;
        applyClientFilters();
      } else if (event.type === 'error') {
        streamError = event.message as string;
      }
    });
    if (streamError) throw new Error(streamError);
  } catch (err) {
    setStatus((err as Error).message, 'error');
  } finally {
    btn.textContent = 'Apply AI Filter';
    renderDerived();
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

// Looks up a listing card by URL. Returns null if not yet rendered.
function getCardByUrl(url: string): HTMLElement | null {
  const id = cardIdByUrl.get(url);
  return id ? document.getElementById(id) : null;
}


function shippingBadge(fulfillment: Listing['fulfillment']): string {
  if (!fulfillment) return '';
  if (fulfillment.pickupAvailable && fulfillment.shippingAvailable) return '<span class="badge badge-both">Allows pickups</span>';
  if (fulfillment.pickupAvailable) return '<span class="badge badge-pickuponly">Pickup only</span>';
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

function buildPricesHtml(item: ListingItem): string {
  let html = `<span class="price">${esc(item.data.priceDisplay)}</span>`;
  if (item.detail && item.data.isAuction && item.detail.buyNowPrice != null) {
    html += `<span class="price-buynow">Buy Now: <strong>$${Number(item.detail.buyNowPrice).toLocaleString()}</strong></span>`;
  }
  return html;
}

function buildMetaHtml(item: ListingItem): string {
  let html = sourceFaviconHtml(item.data.source);
  html += `<span class="meta-text">📍 ${esc(item.data.location)}</span>`;
  const detail = item.detail;
  if (detail) {
    const { shippingAvailable, pickupAvailable } = detail;
    const hasDefiniteData = shippingAvailable !== null || pickupAvailable !== null;
    if (item.data.isAuction) {
      const reserve = reserveText(detail.reserveStatus);
      if (reserve) html += `<span class="badge badge-${detail.reserveStatus.toLowerCase().replace('_', '-')}">${esc(reserve)}</span>`;
    }
    if (hasDefiniteData) {
      if (shippingAvailable && pickupAvailable) {
        html += '<span class="badge badge-both">Shipping &amp; pickup</span>';
      } else if (shippingAvailable) {
        html += '<span class="badge badge-shipping">Shipping only</span>';
      } else if (pickupAvailable) {
        html += '<span class="badge badge-pickuponly">Pickup only</span>';
      }
    } else {
      html += shippingBadge(item.data.fulfillment);
    }
  } else {
    html += shippingBadge(item.data.fulfillment);
  }
  return html;
}

function buildExtrasHtml(detail: ListingDetail): string {
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

  return `<div class="extras-body collapsed">${body}<div class="extras-fade"></div></div><button class="extras-toggle" style="display:none">Show less</button>`;
}

function renderCard(item: ListingItem): void {
  const listing = item.data;

  // Assign a UUID-based id on first render; reuse it on re-renders (e.g. after deep search enrichment).
  let id = cardIdByUrl.get(listing.url);
  if (!id) {
    id = 'card-' + crypto.randomUUID();
    cardIdByUrl.set(listing.url, id);
  }

  const existing = document.getElementById(id);
  const card = existing ?? document.createElement('div');
  card.className = `listing-card${item.detail ? ' enriched' : ''}`;
  card.id = id;
  card.dataset.url = listing.url;

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
          ${buildPricesHtml(item)}
        </div>
        <div class="listing-meta">
          ${buildMetaHtml(item)}
        </div>
        <div class="listing-extras">${item.detail ? buildExtrasHtml(item.detail) : ''}</div>
      </div>
    </div>
  `;

  if (!existing) el('listingsContainer').appendChild(card);
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
  const toScrape = getOrderedListings()
    .filter(item => !item.deepSearched && item.filterReason === null && item.aiFilterReason === null)
    .map(item => item.data);

  if (toScrape.length === 0) return;

  setDeepSearchId(crypto.randomUUID());
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(true);
  let hiddenByDescription = 0;
  let detailsReceived = 0;

  for (const listing of toScrape) {
    const card = getCardByUrl(listing.url);
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
        const item = listingsByUrl.get(ev.url as string);
        if (item) {
          item.deepSearched = true;
          item.detail = detail;
          item.data.description = detail.description;
          if (detail.shippingAvailable !== null && detail.pickupAvailable !== null) {
            item.data.fulfillment = {
              shippingAvailable: detail.shippingAvailable,
              pickupAvailable: detail.pickupAvailable,
            };
          }
          item.aiCheckedHash = null;
          renderCard(item);

          const card = getCardByUrl(item.data.url);
          const wasVisible = card !== null && card.style.display !== 'none';
          item.filterReason = computeFilterReason(item.data, getFilters());
          if (wasVisible && item.filterReason !== null) {
            const banner = card!.querySelector<HTMLElement>('.filter-banner')!;
            card!.classList.add('filtered-out');
            banner.textContent = filterBannerText(item);
            banner.classList.remove('hidden');
            if (!showFilteredListings) card!.style.display = 'none';
            hiddenByDescription++;
          }
        }

        renderDerived();
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
    const item = listingsByUrl.get(listing.url);
    if (item && !item.deepSearched) {
      const card = getCardByUrl(listing.url);
      if (card) card.querySelector('.listing-extras')!.innerHTML = '';
    }
  }

  if (deepSearchCancellationRequested) {
    setStatus(`Cancelled — ${detailsReceived}/${toScrape.length} detail${toScrape.length !== 1 ? 's' : ''} loaded`, 'error');
  }

  setDeepSearchId(null);
  setDeepSearchCancellationRequested(false);
  setDeepSearchBusy(false);
  applyClientFilters();
}

function markDirty(): void {
  el('saveCurrentBtn').classList.remove('hidden');
}

function setSearchName(name: string | null): void {
  setCurrentSearchName(name);
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

function loadDiscoveryResults(data: { urls: string[]; filters: FrontendFilters; name: string }, aiPrompt: string): void {
  resetAllResults();
  while (urlCardStates.length > 1) removeUrlCard(urlCardStates[urlCardStates.length - 1]);
  urlCardStates[0].input.value = data.urls[0];
  updateCardSearchBtn(urlCardStates[0]);
  for (let i = 1; i < data.urls.length; i++) {
    const state = createUrlCard();
    state.input.value = data.urls[i];
    updateCardSearchBtn(state);
  }
  setFilters(data.filters);
  setSearchName(data.name);
  markDirty();
  el<HTMLTextAreaElement>('aiFilter').value = aiPrompt;
  applyClientFilters();
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

// Initialise with the first URL card; focus discovery prompt on load
const firstCard = createUrlCard();
el<HTMLTextAreaElement>('discoveryPrompt').focus();

el('addUrlBtn').addEventListener('click', () => {
  const newCard = createUrlCard();
  newCard.input.focus();
  newCard.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

el<HTMLButtonElement>('deepBtn').addEventListener('click', () => runDeepSearch());

el('toggleFilteredBtn').addEventListener('click', () => {
  setShowFilteredListings(!showFilteredListings);
  el<HTMLButtonElement>('toggleFilteredBtn').textContent = showFilteredListings ? 'hide' : 'show';
  for (const item of getOrderedListings()) {
    if (item.filterReason !== null || item.aiFilterReason !== null) {
      const card = getCardByUrl(item.data.url);
      if (card) card.style.display = showFilteredListings ? '' : 'none';
    }
  }
});


// Populate region dropdown and wire fulfillment toggle
fetch('/api/regions').then(r => r.json()).then((regions: Array<{ value: string; display: string }>) => {
  const select = el<HTMLSelectElement>('discoveryRegion');
  for (const region of regions) {
    const opt = document.createElement('option');
    opt.value = region.value;
    opt.textContent = region.display;
    select.appendChild(opt);
  }
}).catch(() => { /* regions unavailable — dropdown stays empty */ });

el<HTMLSelectElement>('discoveryFulfillment').addEventListener('change', () => {
  const isPickup = el<HTMLSelectElement>('discoveryFulfillment').value === 'pickup';
  el('discoveryRegion').style.display = isPickup ? '' : 'none';
  updateDiscoveryBtn();
});
el<HTMLSelectElement>('discoveryRegion').addEventListener('change', updateDiscoveryBtn);

el<HTMLTextAreaElement>('discoveryPrompt').addEventListener('input', updateDiscoveryBtn);
el<HTMLInputElement>('discoveryMaxPrice').addEventListener('input', updateDiscoveryBtn);
el<HTMLButtonElement>('discoveryBtn').addEventListener('click', async () => {
  const prompt = el<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  if (!prompt) return;
  const maxPriceVal = el<HTMLInputElement>('discoveryMaxPrice').value.trim();
  const maxPrice = maxPriceVal ? parseFloat(maxPriceVal) : undefined;
  const fulfillment = el<HTMLSelectElement>('discoveryFulfillment').value;
  const regionValue = fulfillment === 'pickup' ? el<HTMLSelectElement>('discoveryRegion').value : undefined;
  const btn = el<HTMLButtonElement>('discoveryBtn');
  const errorEl = el<HTMLDivElement>('discoveryError');
  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const res = await fetch('/api/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxPrice, fulfillment, regionValue }),
    });
    const data = await res.json() as { urls?: string[]; filters?: FrontendFilters; name?: string; error?: string };
    if (!res.ok || !data.urls?.length) {
      errorEl.textContent = data.error ?? 'Discovery failed';
      errorEl.style.display = 'block';
      return;
    }
    loadDiscoveryResults(data as { urls: string[]; filters: FrontendFilters; name: string }, prompt);
  } catch {
    errorEl.textContent = 'Discovery failed';
    errorEl.style.display = 'block';
  } finally {
    btn.textContent = 'Get it!';
    updateDiscoveryBtn();
  }
});

el<HTMLTextAreaElement>('aiFilter').addEventListener('input', renderDerived);
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
  const input = el<HTMLInputElement>('saveSearchName');
  input.value = currentSearchName ?? '';
  input.select();
  el('saveSearchModal').classList.remove('hidden');
  input.focus();
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
