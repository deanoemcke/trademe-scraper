import { computeFilterReason, type FrontendFilters } from '../lib/filters';
import { isValidRecipeUrl } from '../lib/recipes/matcher';
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

function promptHash(inputString: string): number {
  let h = 5381;
  for (let charIndex = 0; charIndex < inputString.length; charIndex++) h = (h * 33 ^ inputString.charCodeAt(charIndex)) >>> 0;
  return h;
}


function getElement<T extends HTMLElement>(id: string): T {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Element #${id} not found`);
  return elem as T;
}

function getFilters(overrides?: Partial<FrontendFilters>): FrontendFilters {
  const minimumPriceRaw = getElement<HTMLInputElement>('minPrice').value;
  const maximumPriceRaw = getElement<HTMLInputElement>('maxPrice').value;
  const keywordsRaw     = getElement<HTMLInputElement>('keywords').value.trim();
  const excludedKeywordsRaw = getElement<HTMLInputElement>('excludeKeywords').value.trim();
  return {
    minPrice: minimumPriceRaw ? parseFloat(minimumPriceRaw) : undefined,
    maxPrice: maximumPriceRaw ? parseFloat(maximumPriceRaw) : undefined,
    keywords: keywordsRaw ? keywordsRaw.split(',').map(keyword => keyword.trim()).filter(Boolean) : undefined,
    excludeKeywords: excludedKeywordsRaw ? excludedKeywordsRaw.split(',').map(keyword => keyword.trim()).filter(Boolean) : undefined,
    shippingAvailable: getElement<HTMLInputElement>('filterShipping').checked,
    pickupAvailable:   getElement<HTMLInputElement>('filterPickup').checked,
    ...overrides,
  };
}


function setFilters(filters: FrontendFilters): void {
  getElement<HTMLInputElement>('minPrice').value = filters.minPrice != null ? String(filters.minPrice) : '';
  getElement<HTMLInputElement>('maxPrice').value = filters.maxPrice != null ? String(filters.maxPrice) : '';
  getElement<HTMLInputElement>('keywords').value = filters.keywords?.join(', ') ?? '';
  getElement<HTMLInputElement>('excludeKeywords').value = filters.excludeKeywords?.join(', ') ?? '';
  getElement<HTMLInputElement>('filterShipping').checked = filters.shippingAvailable ?? true;
  getElement<HTMLInputElement>('filterPickup').checked = filters.pickupAvailable ?? true;
}

function setCardStatus(state: UrlCardState, statusMessage: string | null, type: 'info' | 'success' | 'error' = 'info'): void {
  const statusBar = state.statusElement;
  if (!statusMessage) { statusBar.classList.add('hidden'); return; }
  statusBar.className = `url-card-status ${type}`;
  statusBar.innerHTML = type === 'info'
    ? `<span class="spinner"></span><span>${esc(statusMessage)}</span>`
    : `<span>${esc(statusMessage)}</span>`;
  statusBar.classList.remove('hidden');
}

function setSearchingStatus(state: UrlCardState, statusMessage: string): void {
  const statusBar = state.statusElement;
  statusBar.className = 'url-card-status info';
  statusBar.innerHTML = `<span class="spinner"></span><span>${esc(statusMessage)}</span>`;
  if (!state.isCancellationRequested) {
    const cancelButton = document.createElement('button');
    cancelButton.className = 'cache-clear-btn';
    cancelButton.style.marginLeft = '0.5rem';
    cancelButton.textContent = 'cancel';
    cancelButton.addEventListener('click', () => cancelSearch(state));
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove('hidden');
}

function cancelSearch(state: UrlCardState): void {
  if (!state.isSearching || state.isCancellationRequested) return;
  state.isCancellationRequested = true;
  setSearchingStatus(state, 'Cancelling…');
  fetch('/api/cancel-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchId: state.searchId }),
  }).catch(() => null);
}

function setDeepSearchingStatus(statusMessage: string): void {
  const statusBar = getElement('statusBar');
  statusBar.className = 'status-bar info';
  statusBar.innerHTML = `<span class="spinner"></span><span>${esc(statusMessage)}</span>`;
  if (!deepSearchCancellationRequested) {
    const cancelButton = document.createElement('button');
    cancelButton.className = 'cache-clear-btn';
    cancelButton.style.marginLeft = '0.5rem';
    cancelButton.textContent = 'cancel';
    cancelButton.addEventListener('click', cancelDeepSearch);
    statusBar.appendChild(cancelButton);
  }
  statusBar.classList.remove('hidden');
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

function setStatus(statusMessage: string | null, type: 'info' | 'success' | 'error' = 'info'): void {
  const statusBar = getElement('statusBar');
  if (!statusMessage) { statusBar.classList.add('hidden'); return; }
  statusBar.className = `status-bar ${type}`;
  statusBar.innerHTML = type === 'info'
    ? `<span class="spinner"></span><span>${esc(statusMessage)}</span>`
    : `<span>${esc(statusMessage)}</span>`;
  statusBar.classList.remove('hidden');
}

function updateCardSearchBtn(state: UrlCardState): void {
  const current = state.input.value.trim();
  const alreadySearched = state.hasBeenSearched && current === state.searchedUrl;
  state.searchButton.disabled = state.isSearching || isDeepSearchRunning || !isValidRecipeUrl(current) || alreadySearched;
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
  getElement('urlCardsContainer').appendChild(card);

  const input = card.querySelector<HTMLInputElement>('.url-input')!;
  const searchButton = card.querySelector<HTMLButtonElement>('.url-search-btn')!;
  const removeButton = card.querySelector<HTMLButtonElement>('.url-remove-btn')!;
  const criteriaElement = card.querySelector<HTMLElement>('.url-criteria')!;
  const countElement = card.querySelector<HTMLElement>('.url-card-count')!;
  const cacheStatusElement = card.querySelector<HTMLElement>('.cache-status')!;
  const statusElement = card.querySelector<HTMLElement>('.url-card-status')!;

  const state: UrlCardState = { containerElement: card, input, searchButton, removeButton, criteriaElement, countElement, cacheStatusElement, statusElement, hasBeenSearched: false, searchedUrl: '', isSearching: false, searchId: null, isCancellationRequested: false, listingUrls: [] };
  urlCardStates.push(state);

  input.addEventListener('input', () => updateCardSearchBtn(state));
  input.addEventListener('keydown', (keyboardEvent: KeyboardEvent) => {
    if (keyboardEvent.key === 'Enter' && !searchButton.disabled) searchUrlCardAsync(state);
  });
  searchButton.addEventListener('click', () => searchUrlCardAsync(state));
  removeButton.addEventListener('click', () => removeUrlCard(state));

  updateRemoveButtons();
  return state;
}

function resetAllResults(): void {
  listingsByUrl.clear();
  getElement('listingsContainer').innerHTML = '';
  getElement('resultCount').textContent = '0';
  setShowFilteredListings(false);
  getElement<HTMLButtonElement>('toggleFilteredBtn').textContent = 'show';
  getElement('filteredCount').classList.add('hidden');
  getElement('resultsSection').classList.add('hidden');
  for (const cardState of urlCardStates) {
    cardState.listingUrls = [];
    cardState.hasBeenSearched = false;
    cardState.searchedUrl = '';
    cardState.countElement.textContent = '';
    cardState.criteriaElement.querySelector('.criteria-grid')!.innerHTML = '';
    cardState.criteriaElement.classList.add('hidden');
    cardState.cacheStatusElement.classList.add('hidden');
    cardState.cacheStatusElement.innerHTML = '';
    cardState.statusElement.classList.add('hidden');
    cardState.isSearching = false;
    cardState.searchId = null;
    cardState.isCancellationRequested = false;
    cardState.input.readOnly = false;
    updateCardSearchBtn(cardState);
  }
  renderDerived();
}

function getOrderedListings(): ListingItem[] {
  const seen = new Set<string>();
  return urlCardStates
    .flatMap(cardState => cardState.listingUrls.filter(listingUrl => !seen.has(listingUrl) && seen.add(listingUrl)))
    .map(listingUrl => listingsByUrl.get(listingUrl)!)
    .filter(Boolean);
}

function renderDerived(): void {
  const listings = getOrderedListings();
  const visible = listings.filter(listingItem => listingItem.filterReason === null && listingItem.aiFilterReason === null);
  const filtered = listings.length - visible.length;
  getElement('resultCount').textContent = String(visible.length);
  getElement('filteredCountNum').textContent = String(filtered);
  getElement('filteredCount').classList.toggle('hidden', filtered === 0);
  const isAnyCardSearching = urlCardStates.some(cardState => cardState.isSearching);
  const hasUnscraped = visible.some(listingItem => !listingItem.hasBeenDeepSearched);
  getElement<HTMLButtonElement>('deepBtn').disabled = isDeepSearchRunning || isAnyCardSearching || !hasUnscraped;
  const prompt = getElement<HTMLTextAreaElement>('aiFilter').value.trim();
  const hash = promptHash(prompt);
  getElement<HTMLButtonElement>('applyAiFilterBtn').disabled =
    !prompt || listings.length === 0 || listings.every(listingItem => listingItem.aiCheckedHash === hash);
}

function updateRemoveButtons(): void {
  const show = urlCardStates.length > 1;
  for (const cardState of urlCardStates) cardState.removeButton.classList.toggle('hidden', !show);
}

function resetCardForResearch(state: UrlCardState): void {
  const otherUrls = new Set(urlCardStates.flatMap(cardState => cardState === state ? [] : cardState.listingUrls));
  for (const url of state.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
    }
  }
  state.listingUrls = [];
  state.hasBeenSearched = false;
  state.searchedUrl = '';
  state.countElement.textContent = '';
  state.criteriaElement.querySelector('.criteria-grid')!.innerHTML = '';
  state.criteriaElement.classList.add('hidden');
  state.cacheStatusElement.classList.add('hidden');
  state.cacheStatusElement.innerHTML = '';
  state.statusElement.classList.add('hidden');
  state.input.readOnly = false;
  if (getOrderedListings().length === 0) getElement('resultsSection').classList.add('hidden');
  renderDerived();
}

function removeUrlCard(state: UrlCardState): void {
  const otherUrls = new Set(urlCardStates.flatMap(cardState => cardState === state ? [] : cardState.listingUrls));
  for (const url of state.listingUrls) {
    if (!otherUrls.has(url)) {
      getCardByUrl(url)?.remove();
      listingsByUrl.delete(url);
      cardIdByUrl.delete(url);
    }
  }
  state.containerElement.remove();
  const cardIndex = urlCardStates.indexOf(state);
  if (cardIndex !== -1) urlCardStates.splice(cardIndex, 1);
  if (getOrderedListings().length === 0) getElement('resultsSection').classList.add('hidden');
  updateRemoveButtons();
  applyClientFilters();
}

async function searchUrlCardAsync(state: UrlCardState): Promise<void> {
  const url = state.input.value.trim();
  if (!isValidRecipeUrl(url)) return;

  if (state.hasBeenSearched) resetCardForResearch(state);

  getElement('resultsSection').classList.remove('hidden');
  state.isSearching = true;
  state.searchId = crypto.randomUUID();
  state.isCancellationRequested = false;
  updateCardSearchBtn(state);
  renderDerived();
  setSearchingStatus(state, 'Fetching listings…');

  let totalFound = 0;
  let cachedAge = '';
  let searchError = false;
  try {
    await streamPostAsync('/api/quick-search', { url, searchId: state.searchId }, (ev) => {
      if (ev.type === 'criteria') {
        const filters = ev.filters as Array<[string, string]>;
        state.criteriaElement.querySelector('.criteria-grid')!.innerHTML = filters
          .map(([k, v]) => `<div class="criteria-row"><span class="criteria-key">${esc(k)}</span><span class="criteria-val">${esc(v)}</span></div>`)
          .join('');
        state.criteriaElement.classList.remove('hidden');
      } else if (ev.type === 'cached') {
        cachedAge = ev.age as string;
      } else if (ev.type === 'progress') {
        if (!state.isCancellationRequested) setSearchingStatus(state, ev.message as string);
      } else if (ev.type === 'listing') {
        const listing = ev.data as Listing;
        totalFound++;
        state.listingUrls.push(listing.url);
        if (!listingsByUrl.has(listing.url)) {
          const item: ListingItem = { data: listing, detail: null, hasBeenDeepSearched: false, filterReason: null, aiCheckedHash: null, aiFilterReason: null };
          listingsByUrl.set(listing.url, item);
          renderCard(item);
          renderDerived();
        }
      } else if (ev.type === 'error') {
        searchError = true;
        setCardStatus(state, ev.message as string, 'error');
      }
    });
  } catch (error) {
    searchError = true;
    setCardStatus(state, (error as Error).message, 'error');
  }

  state.isSearching = false;
  const wasCancelled = state.isCancellationRequested;
  state.searchId = null;
  state.isCancellationRequested = false;

  if (wasCancelled) {
    setCardStatus(state, `Cancelled — ${totalFound} listing${totalFound !== 1 ? 's' : ''} loaded`, 'error');
    updateCardSearchBtn(state);
    if (listingsByUrl.size > 0) applyClientFilters();
    return;
  }

  state.hasBeenSearched = true;
  state.searchedUrl = url;
  state.input.readOnly = true;
  updateCardSearchBtn(state);

  if (cachedAge) {
    state.cacheStatusElement.innerHTML =
      `Loaded from cache — ${esc(cachedAge)} <button class="cache-clear-btn">Clear</button>`;
    state.cacheStatusElement.classList.remove('hidden');
    state.cacheStatusElement.querySelector('.cache-clear-btn')!.addEventListener('click', clearQuickSearchCacheAsync);
  }
  state.countElement.textContent = `— ${totalFound} listing${totalFound !== 1 ? 's' : ''}`;

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
  const hasPrompt = !!getElement<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  const maxPriceRaw = getElement<HTMLInputElement>('discoveryMaxPrice').value.trim();
  const hasValidPrice = maxPriceRaw !== '' && isFinite(parseFloat(maxPriceRaw)) && parseFloat(maxPriceRaw) > 0;
  const isPickupOnly = getElement<HTMLSelectElement>('discoveryFulfillment').value === 'pickup';
  const hasRegion = !isPickupOnly || !!getElement<HTMLSelectElement>('discoveryRegion').value;
  getElement<HTMLButtonElement>('discoveryBtn').disabled = !hasPrompt || !hasValidPrice || !hasRegion;
}

async function runAiFilterAsync(): Promise<void> {
  const prompt = getElement<HTMLTextAreaElement>('aiFilter').value.trim();
  if (!prompt) return;
  const hash = promptHash(prompt);
  const toCheck = getOrderedListings().filter(item => item.aiCheckedHash !== hash && item.filterReason === null);
  if (toCheck.length === 0) return;

  const applyButton = getElement<HTMLButtonElement>('applyAiFilterBtn');
  applyButton.disabled = true;
  let checked = 0;
  applyButton.textContent = `Filtering 0/${toCheck.length}…`;

  let streamError: string | null = null;

  try {
    await streamPostAsync('/api/ai-filter', {
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
        applyButton.textContent = `Filtering ${checked}/${toCheck.length}…`;
        applyClientFilters();
      } else if (event.type === 'error') {
        streamError = event.message as string;
      }
    });
    if (streamError) throw new Error(streamError);
  } catch (error) {
    setStatus((error as Error).message, 'error');
  } finally {
    applyButton.textContent = 'Apply AI Filter';
    renderDerived();
  }
}

async function clearQuickSearchCacheAsync(): Promise<void> {
  await fetch('/api/cache/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'quick-search' }),
  }).catch(() => null);
  resetAllResults();
}

// ── SSE streaming ─────────────────────────────────────────────────────────────

async function streamPostAsync(
  endpoint: string,
  body: unknown,
  onData: (data: Record<string, unknown>) => void,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
    throw new Error(errorBody.error ?? `HTTP ${response.status}`);
  }
  const reader = response.body!.getReader();
  const textDecoder = new TextDecoder();
  let streamBuffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    streamBuffer += textDecoder.decode(value, { stream: true });
    const lines = streamBuffer.split('\n');
    streamBuffer = lines.pop() ?? '';
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


function renderShippingBadgeHtml(fulfillment: Listing['fulfillment']): string {
  if (!fulfillment) return '';
  if (fulfillment.pickupAvailable && fulfillment.shippingAvailable) return '<span class="badge badge-both">Allows pickups</span>';
  if (fulfillment.pickupAvailable) return '<span class="badge badge-pickuponly">Pickup only</span>';
  return '';
}

function formatReserveText(status: string): string {
  if (status === 'NONE') return 'No reserve';
  if (status === 'MET') return 'Reserve met';
  if (status === 'NOT_MET') return 'Reserve not met';
  return '';
}

function cleanDescription(text: string): string {
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
      const reserve = formatReserveText(detail.reserveStatus);
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
      html += renderShippingBadgeHtml(item.data.fulfillment);
    }
  } else {
    html += renderShippingBadgeHtml(item.data.fulfillment);
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
    body += `<div class="listing-description">${esc(cleanDescription(detail.description))}</div>`;
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
  let cardId = cardIdByUrl.get(listing.url);
  if (!cardId) {
    cardId = 'card-' + crypto.randomUUID();
    cardIdByUrl.set(listing.url, cardId);
  }

  const existing = document.getElementById(cardId);
  const card = existing ?? document.createElement('div');
  card.className = `listing-card${item.detail ? ' enriched' : ''}`;
  card.id = cardId;
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

  if (!existing) getElement('listingsContainer').appendChild(card);
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

function toggleDescription(btn: HTMLButtonElement): void {
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

async function runDeepSearchAsync(): Promise<void> {
  const toScrape = getOrderedListings()
    .filter(item => !item.hasBeenDeepSearched && item.filterReason === null && item.aiFilterReason === null)
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
    await streamPostAsync('/api/deep-search', { listings: toScrape, deepSearchId }, (ev) => {
      if (ev.type === 'progress') {
        if (!deepSearchCancellationRequested) setDeepSearchingStatus(`Fetching details ${ev.index}/${ev.total} — ${String(ev.title).slice(0, 55)}…`);
      } else if (ev.type === 'detail') {
        detailsReceived++;
        const detail = ev.detail as ListingDetail;
        const item = listingsByUrl.get(ev.url as string);
        if (item) {
          item.hasBeenDeepSearched = true;
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
        const completionMessage = hiddenByDescription > 0
          ? `Deep search complete — ${hiddenByDescription} listing${hiddenByDescription !== 1 ? 's' : ''} hidden by description filter`
          : 'Deep search complete';
        setStatus(completionMessage, hiddenByDescription > 0 ? 'info' : 'success');
        setTimeout(() => setStatus(null), 4000);
      } else if (ev.type === 'error') {
        setStatus(ev.message as string, 'error');
      }
    });
  } catch (error) {
    setStatus((error as Error).message, 'error');
  }

  // Clear skeleton loaders from listings that never received details
  for (const listing of toScrape) {
    const item = listingsByUrl.get(listing.url);
    if (item && !item.hasBeenDeepSearched) {
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
  getElement('saveCurrentBtn').classList.remove('hidden');
}

function setSearchName(name: string | null): void {
  setCurrentSearchName(name);
  getElement('searchTitle').textContent = name ?? 'new shiny thing';
  getElement('saveCurrentBtn').classList.add('hidden');
}

// ── Saved searches ────────────────────────────────────────────────────────────

async function fetchSavedSearchesAsync(): Promise<void> {
  try {
    const response = await fetch('/api/saved-searches', { cache: 'no-store' });
    const data = await response.json() as { searches: SavedSearch[] };
    renderSavedSearches(data.searches);
  } catch { /* non-critical */ }
}

function renderSavedSearches(searches: SavedSearch[]): void {
  const list = getElement('savedSearchesList');
  const count = getElement('savedSearchesCount');

  count.textContent = String(searches.length);
  count.classList.toggle('hidden', searches.length === 0);

  if (searches.length === 0) {
    list.innerHTML = '<p class="deep-empty">No saved searches yet.</p>';
    return;
  }
  list.innerHTML = searches.map(savedSearch => `
    <div class="saved-search-row" data-id="${esc(savedSearch.id)}">
      <a class="saved-search-name load-saved-btn" href="#" title="${esc(savedSearch.name)}">${esc(savedSearch.name)}</a>
      <span class="saved-search-date">${new Date(savedSearch.createdAt).toLocaleDateString()} ${new Date(savedSearch.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
      <button class="btn btn-ghost delete-saved-btn" style="padding:0.25rem 0.65rem;font-size:0.78rem">✕</button>
    </div>
  `).join('');
}

async function saveCurrentSearchAsync(name: string): Promise<void> {
  const urls = urlCardStates.map(cardState => cardState.input.value.trim()).filter(Boolean);
  if (!name.trim() || urls.length === 0) return;
  const response = await fetch('/api/saved-searches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), urls, filters: getFilters(), aiFilter: getElement<HTMLTextAreaElement>('aiFilter').value.trim() || null }),
  });
  if (response.ok) await fetchSavedSearchesAsync();
}

async function deleteSavedSearchAsync(id: string): Promise<void> {
  await fetch(`/api/saved-searches/${id}`, { method: 'DELETE' });
  await fetchSavedSearchesAsync();
}

function loadDiscoveryResults(data: { urls: string[]; filters: FrontendFilters; name: string }, aiPrompt: string): void {
  resetAllResults();
  while (urlCardStates.length > 1) removeUrlCard(urlCardStates[urlCardStates.length - 1]);
  urlCardStates[0].input.value = data.urls[0];
  updateCardSearchBtn(urlCardStates[0]);
  for (let urlIndex = 1; urlIndex < data.urls.length; urlIndex++) {
    const state = createUrlCard();
    state.input.value = data.urls[urlIndex];
    updateCardSearchBtn(state);
  }
  setFilters(data.filters);
  setSearchName(data.name);
  markDirty();
  getElement<HTMLTextAreaElement>('aiFilter').value = aiPrompt;
  applyClientFilters();
}

async function loadSavedSearchAsync(search: SavedSearch): Promise<void> {
  resetAllResults();
  while (urlCardStates.length > 1) removeUrlCard(urlCardStates[urlCardStates.length - 1]);
  if (search.urls.length === 0) return;
  urlCardStates[0].input.value = search.urls[0];
  updateCardSearchBtn(urlCardStates[0]);
  for (let urlIndex = 1; urlIndex < search.urls.length; urlIndex++) {
    const state = createUrlCard();
    state.input.value = search.urls[urlIndex];
    updateCardSearchBtn(state);
  }
  setFilters(search.filters);
  getElement<HTMLTextAreaElement>('aiFilter').value = search.aiFilter ?? '';
  setSearchName(search.name);
  getElement('savedSearchesPanel').classList.add('hidden');
  applyClientFilters();
  for (const state of urlCardStates) searchUrlCardAsync(state);
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Initialise with the first URL card; focus discovery prompt on load
const firstCard = createUrlCard();
getElement<HTMLTextAreaElement>('discoveryPrompt').focus();

getElement('addUrlBtn').addEventListener('click', () => {
  const newCard = createUrlCard();
  newCard.input.focus();
  newCard.containerElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

getElement<HTMLButtonElement>('deepBtn').addEventListener('click', () => runDeepSearchAsync());

getElement('toggleFilteredBtn').addEventListener('click', () => {
  setShowFilteredListings(!showFilteredListings);
  getElement<HTMLButtonElement>('toggleFilteredBtn').textContent = showFilteredListings ? 'hide' : 'show';
  for (const item of getOrderedListings()) {
    if (item.filterReason !== null || item.aiFilterReason !== null) {
      const card = getCardByUrl(item.data.url);
      if (card) card.style.display = showFilteredListings ? '' : 'none';
    }
  }
});


// Populate region dropdown and wire fulfillment toggle
fetch('/api/regions').then(regionResponse => regionResponse.json()).then((regions: Array<{ value: string; display: string }>) => {
  const select = getElement<HTMLSelectElement>('discoveryRegion');
  for (const region of regions) {
    const opt = document.createElement('option');
    opt.value = region.value;
    opt.textContent = region.display;
    select.appendChild(opt);
  }
}).catch(() => { /* regions unavailable — dropdown stays empty */ });

getElement<HTMLSelectElement>('discoveryFulfillment').addEventListener('change', () => {
  const isPickup = getElement<HTMLSelectElement>('discoveryFulfillment').value === 'pickup';
  getElement('discoveryRegion').style.display = isPickup ? '' : 'none';
  updateDiscoveryBtn();
});
getElement<HTMLSelectElement>('discoveryRegion').addEventListener('change', updateDiscoveryBtn);

getElement<HTMLTextAreaElement>('discoveryPrompt').addEventListener('input', updateDiscoveryBtn);
getElement<HTMLInputElement>('discoveryMaxPrice').addEventListener('input', updateDiscoveryBtn);
getElement<HTMLButtonElement>('discoveryBtn').addEventListener('click', async () => {
  const prompt = getElement<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  if (!prompt) return;
  const maxPriceVal = getElement<HTMLInputElement>('discoveryMaxPrice').value.trim();
  const maxPrice = maxPriceVal ? parseFloat(maxPriceVal) : undefined;
  const fulfillment = getElement<HTMLSelectElement>('discoveryFulfillment').value;
  const regionValue = fulfillment === 'pickup' ? getElement<HTMLSelectElement>('discoveryRegion').value : undefined;
  const discoveryButton = getElement<HTMLButtonElement>('discoveryBtn');
  const discoveryErrorElement = getElement<HTMLDivElement>('discoveryError');
  discoveryErrorElement.style.display = 'none';
  discoveryButton.disabled = true;
  discoveryButton.textContent = 'Working…';
  try {
    const response = await fetch('/api/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxPrice, fulfillment, regionValue }),
    });
    const data = await response.json() as { urls?: string[]; filters?: FrontendFilters; name?: string; error?: string };
    if (!response.ok || !data.urls?.length) {
      discoveryErrorElement.textContent = data.error ?? 'Discovery failed';
      discoveryErrorElement.style.display = 'block';
      return;
    }
    loadDiscoveryResults(data as { urls: string[]; filters: FrontendFilters; name: string }, prompt);
  } catch {
    discoveryErrorElement.textContent = 'Discovery failed';
    discoveryErrorElement.style.display = 'block';
  } finally {
    discoveryButton.textContent = 'Get it!';
    updateDiscoveryBtn();
  }
});

getElement<HTMLTextAreaElement>('aiFilter').addEventListener('input', renderDerived);
getElement<HTMLTextAreaElement>('aiFilter').addEventListener('input', markDirty);
getElement<HTMLButtonElement>('applyAiFilterBtn').addEventListener('click', () => runAiFilterAsync());

(['minPrice', 'maxPrice', 'keywords', 'excludeKeywords'] as const).forEach(id => {
  getElement(id).addEventListener('input', applyClientFilters);
  getElement(id).addEventListener('input', markDirty);
});
(['filterShipping', 'filterPickup'] as const).forEach(id => {
  getElement(id).addEventListener('change', applyClientFilters);
  getElement(id).addEventListener('change', markDirty);
});

// Mark dirty on any URL input change or new URL card
getElement('urlCardsContainer').addEventListener('input', markDirty);
getElement('addUrlBtn').addEventListener('click', markDirty);

// Event delegation for description toggles (avoids global onclick)
getElement('listingsContainer').addEventListener('click', (mouseEvent: MouseEvent) => {
  const showLessBtn = (mouseEvent.target as HTMLElement).closest<HTMLButtonElement>('.extras-toggle');
  if (showLessBtn) { collapseExtras(showLessBtn); return; }
  const collapsedBody = (mouseEvent.target as HTMLElement).closest<HTMLElement>('.extras-body.collapsed');
  if (collapsedBody) { expandExtras(collapsedBody); return; }
  const descBtn = (mouseEvent.target as HTMLElement).closest<HTMLButtonElement>('.desc-toggle');
  if (descBtn) toggleDescription(descBtn);
});

// ── Saved searches UI ─────────────────────────────────────────────────────────

getElement('savedSearchesToggle').addEventListener('click', () => {
  const panel = getElement('savedSearchesPanel');
  const nowHidden = panel.classList.toggle('hidden');
  if (!nowHidden) fetchSavedSearchesAsync();
});

function openSaveModal(): void {
  const input = getElement<HTMLInputElement>('saveSearchName');
  input.value = currentSearchName ?? '';
  input.select();
  getElement('saveSearchModal').classList.remove('hidden');
  input.focus();
}

function closeSaveModal(): void {
  getElement('saveSearchModal').classList.add('hidden');
}

getElement('saveCurrentBtn').addEventListener('click', openSaveModal);

getElement('saveSearchCancelBtn').addEventListener('click', closeSaveModal);

getElement('saveSearchModal').addEventListener('click', (mouseEvent: MouseEvent) => {
  if (mouseEvent.target === getElement('saveSearchModal')) closeSaveModal();
});

getElement('saveSearchConfirmBtn').addEventListener('click', async () => {
  const name = getElement<HTMLInputElement>('saveSearchName').value.trim();
  if (!name) return;
  const confirmButton = getElement<HTMLButtonElement>('saveSearchConfirmBtn');
  confirmButton.disabled = true;
  await saveCurrentSearchAsync(name);
  setSearchName(name);
  closeSaveModal();
  confirmButton.disabled = false;
  getElement('savedSearchesPanel').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

getElement<HTMLInputElement>('saveSearchName').addEventListener('keydown', (keyboardEvent: KeyboardEvent) => {
  if (keyboardEvent.key === 'Enter') getElement<HTMLButtonElement>('saveSearchConfirmBtn').click();
  if (keyboardEvent.key === 'Escape') closeSaveModal();
});

getElement('savedSearchesList').addEventListener('click', async (mouseEvent: MouseEvent) => {
  const row = (mouseEvent.target as HTMLElement).closest<HTMLElement>('.saved-search-row');
  if (!row) return;
  const savedSearchId = row.dataset.id!;
  if ((mouseEvent.target as HTMLElement).closest('.delete-saved-btn')) {
    await deleteSavedSearchAsync(savedSearchId);
    return;
  }
  if ((mouseEvent.target as HTMLElement).closest('.load-saved-btn')) {
    mouseEvent.preventDefault();
    const response = await fetch(`/api/saved-searches/${savedSearchId}`);
    if (!response.ok) return;
    const { search } = await response.json() as { search: SavedSearch };
    await loadSavedSearchAsync(search);
  }
});
