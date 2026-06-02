import { matchesFilters, type FrontendFilters } from '../lib/filters';
import type { Listing, ListingDetail } from '../lib/scraper';

// ── State ─────────────────────────────────────────────────────────────────────

interface ListingItem {
  data: Listing;
  deepSearched: boolean;
}

let allListings: ListingItem[] = [];
let isRunning = false;

// ── Known query parameter labels ──────────────────────────────────────────────

const KNOWN_PARAMS: Record<string, string> = {
  search_string: 'Search',
  condition: 'Condition',
  sort_order: 'Sort',
};

const PANEL_LABELS: Record<string, string> = {
  '5c34c1efa0ac468f91e15161d549c479': 'RAM',
  '7a2bb94c0cb44806ac995a4fc854bcbc': 'Screen Size',
};

const IGNORED_PARAMS = new Set([
  'rows', 'page', 'return_canonical', 'return_metadata', 'return_ads',
  'return_empty_categories', 'return_super_features', 'return_did_you_mean',
  'return_variants', 'snap_parameters', 'preferred_shipping_location',
  'return_parameter_counts',
]);

// ── URL parsing ───────────────────────────────────────────────────────────────

function parseUrl(urlStr: string): [string, string][] | null {
  try {
    const url = new URL(urlStr);
    if (!url.hostname.includes('trademe')) return null;
    const rows: [string, string][] = [];

    const pathMatch = url.pathname.match(/\/a\/(.+?)\/search/);
    if (pathMatch) {
      const cat = pathMatch[1]
        .split('/')
        .map(s => s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '))
        .join(' › ');
      rows.push(['Category', cat]);
    }

    const grouped: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams.entries()) {
      (grouped[k] = grouped[k] ?? []).push(v);
    }

    for (const [key, vals] of Object.entries(grouped)) {
      if (IGNORED_PARAMS.has(key)) continue;

      if (key in KNOWN_PARAMS) {
        let val = vals.join(', ');
        if (key === 'condition') val = val[0].toUpperCase() + val.slice(1);
        if (key === 'search_string') val = `"${val}"`;
        rows.push([KNOWN_PARAMS[key], val]);
        continue;
      }

      if (key.startsWith('RefinePanel')) {
        const hash = key.replace('RefinePanel', '');
        let label = PANEL_LABELS[hash];
        if (!label) {
          if (vals.some(v => v.toLowerCase().includes('gb'))) label = 'RAM';
          else if (vals.some(v => v.includes('"'))) label = 'Screen Size';
          else label = 'Filter';
        }
        rows.push([label, vals.join(', ')]);
        continue;
      }

      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      rows.push([label, vals.join(', ')]);
    }

    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

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
  const url = el<HTMLInputElement>('searchUrl').value.trim();
  el<HTMLButtonElement>('searchBtn').disabled = busy || !parseUrl(url);
  updateDeepBtn();
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
  const filters = getFilters();
  const hasUnscraped = allListings.some(
    item => !item.deepSearched && matchesFilters(item.data, filters)
  );
  el<HTMLButtonElement>('deepBtn').disabled = isRunning || !hasUnscraped;
}

// ── SSE streaming ─────────────────────────────────────────────────────────────

async function streamPost(
  endpoint: string,
  body: unknown,
  onData: (data: Record<string, unknown>) => void
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
  return 'card-' + (url.match(/\/listing\/(\d+)/)?.[1] ?? Math.random().toString(36).slice(2));
}

function shippingBadge(allowsPickups: number | undefined): string {
  if (allowsPickups === 1) return '<span class="badge badge-shipping">Shipping only</span>';
  if (allowsPickups === 2) return '<span class="badge badge-pickuponly">Pickup only</span>';
  if (allowsPickups === 3) return '<span class="badge badge-both">Allows pickups</span>';
  return '';
}

function reserveBadge(status: string): string {
  if (!status || status === 'UNKNOWN') return '<span class="badge badge-unknown">No auction</span>';
  if (status === 'NONE')    return '<span class="badge badge-none">No reserve</span>';
  if (status === 'MET')     return '<span class="badge badge-met">Reserve met</span>';
  if (status === 'NOT_MET') return '<span class="badge badge-notmet">Reserve not met</span>';
  return '';
}

function renderCard(listing: Listing): void {
  const id = cardId(listing.url);
  const card = document.createElement('div');
  card.className = 'listing-card';
  card.id = id;
  card.dataset.url = listing.url;

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
        <span class="price">${esc(listing.price)}</span>
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

  const pricesEl = card.querySelector('.listing-prices')!;
  let pricesHtml = `<span class="price">${pricesEl.querySelector('.price')!.textContent}</span>`;
  if (detail.buyNowPrice != null) {
    pricesHtml += `<span class="price-buynow">Buy Now: <strong>$${Number(detail.buyNowPrice).toLocaleString()}</strong></span>`;
  }
  pricesEl.innerHTML = pricesHtml;

  const metaEl = card.querySelector('.listing-meta')!;
  let metaHtml = `<span class="meta-text">📍 ${metaEl.querySelector('.meta-text')!.textContent!.slice(2)}</span>`;
  metaEl.querySelectorAll('.badge').forEach(b => { metaHtml += b.outerHTML; });
  metaHtml += reserveBadge(detail.reserveStatus);
  if (detail.pickupOnly) metaHtml += '<span class="badge badge-pickup">Pickup only</span>';
  metaEl.innerHTML = metaHtml;

  const extras = card.querySelector('.listing-extras')!;
  let extrasHtml = '';
  if (detail.pickupLocation) {
    extrasHtml += `<div class="meta-text mt-sm">🚗 ${esc(detail.pickupLocation)}</div>`;
  }
  if (detail.description) {
    const LIMIT = 320;
    const isLong = detail.description.length > LIMIT;
    const shortText = isLong ? detail.description.slice(0, LIMIT) + '…' : detail.description;
    extrasHtml += `<div class="listing-description">
      <span class="desc-short">${esc(shortText)}</span>
      ${isLong ? `<span class="desc-full">${esc(detail.description)}</span>` : ''}
      ${isLong ? `<br><button class="desc-toggle">Show more</button>` : ''}
    </div>`;
  } else {
    extrasHtml += `<div class="listing-description" style="color:var(--text-muted);font-style:italic">No description provided.</div>`;
  }
  extras.innerHTML = extrasHtml;
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

async function startSearch(): Promise<void> {
  const url = el<HTMLInputElement>('searchUrl').value.trim();
  const criteria = parseUrl(url);
  if (!criteria) return;

  setBusy(true);
  allListings = [];

  el('listingsContainer').innerHTML = '';
  el('resultCount').textContent = '0';
  el('resultsSection').classList.remove('hidden');
  el('filtersCard').classList.add('hidden');

  el('criteriaGrid').innerHTML = criteria
    .map(([k, v]) => `<div class="criteria-row"><span class="criteria-key">${esc(k)}</span><span class="criteria-val">${esc(v)}</span></div>`)
    .join('');
  el('criteriaBox').classList.remove('hidden');

  setStatus('Fetching listings…');

  try {
    await streamPost('/api/quick-search', { url, filters: {} }, (ev) => {
      if (ev.type === 'progress') {
        setStatus(ev.message as string);
      } else if (ev.type === 'listing') {
        const listing = ev.data as Listing;
        allListings.push({ data: listing, deepSearched: false });
        renderCard(listing);
        el('resultCount').textContent = String(allListings.length);
      } else if (ev.type === 'complete') {
        setStatus(`${allListings.length} listing${allListings.length !== 1 ? 's' : ''} found`, 'success');
        setTimeout(() => setStatus(null), 3000);
      } else if (ev.type === 'error') {
        setStatus(ev.message as string, 'error');
      }
    });
  } catch (err) {
    setStatus((err as Error).message, 'error');
  }

  setBusy(false);

  if (allListings.length > 0) {
    el('filtersCard').classList.remove('hidden');
    applyClientFilters();
  }
}

// ── Deep Search ───────────────────────────────────────────────────────────────

async function runDeepSearch(): Promise<void> {
  const filters = getFilters();
  const toScrape = allListings
    .filter(item => !item.deepSearched && matchesFilters(item.data, filters))
    .map(item => item.data);

  if (toScrape.length === 0) return;

  setBusy(true);

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
        const item = allListings.find(i => i.data.url === ev.url);
        if (item) item.deepSearched = true;
        enrichCard(ev.url as string, ev.detail as ListingDetail);
        updateDeepBtn();
      } else if (ev.type === 'complete') {
        setStatus('Deep search complete', 'success');
        setTimeout(() => setStatus(null), 3000);
      } else if (ev.type === 'error') {
        setStatus(ev.message as string, 'error');
      }
    });
  } catch (err) {
    setStatus((err as Error).message, 'error');
  }

  setBusy(false);
}

// ── Event listeners ───────────────────────────────────────────────────────────

const searchUrlInput = el<HTMLInputElement>('searchUrl');
searchUrlInput.focus();

searchUrlInput.addEventListener('input', () => {
  el<HTMLButtonElement>('searchBtn').disabled = isRunning || !parseUrl(searchUrlInput.value.trim());
});

searchUrlInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !el<HTMLButtonElement>('searchBtn').disabled) startSearch();
});

el<HTMLButtonElement>('searchBtn').addEventListener('click', startSearch);
el<HTMLButtonElement>('deepBtn').addEventListener('click', runDeepSearch);

(['minPrice', 'maxPrice', 'keywords', 'excludeKeywords'] as const).forEach(id => {
  el(id).addEventListener('input', applyClientFilters);
});
(['filterShipping', 'filterPickup'] as const).forEach(id => {
  el(id).addEventListener('change', applyClientFilters);
});

// Event delegation for description toggles (avoids global onclick)
el('listingsContainer').addEventListener('click', (e: MouseEvent) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.desc-toggle');
  if (btn) toggleDesc(btn);
});
