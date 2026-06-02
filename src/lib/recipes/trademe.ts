import { chromium, Page, Response } from 'playwright';
import type { Recipe, Listing, ListingDetail, QuickSearchEvent, DeepSearchEvent } from './base';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TRADEME_BASE = 'https://www.trademe.co.nz/a';

type ApiItem = Record<string, unknown>;

// ── Implicit filter extraction ────────────────────────────────────────────────

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

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const rows: Array<[string, string]> = [];

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

    return rows;
  } catch {
    return [];
  }
}

// ── API response parsing ──────────────────────────────────────────────────────

export function parseSearchApiResponse(data: Record<string, unknown>): { listings: Listing[]; totalCount: number; pageSize: number } {
  const items = (data?.List ?? []) as ApiItem[];
  const totalCount = (data?.TotalCount as number) ?? 0;
  const pageSize = (data?.PageSize as number) || (items.length || 1);
  const listings = items
    .map((item) => ({
      title: (item.Title as string) ?? '',
      price: (item.PriceDisplay as string) ?? 'Price on request',
      location: [(item.Suburb as string), (item.Region as string)].filter(Boolean).join(', ') || 'Unknown',
      url: (item.CanonicalPath as string) ? `${TRADEME_BASE}${item.CanonicalPath}` : '',
      thumbnailUrl: ((item.PictureHref as string) || undefined)
        ?.replace('/photoserver/thumb/', '/photoserver/full/'),
      allowsPickups: (item.AllowsPickups as number) || undefined,
      isAuction: true,
    }))
    .filter((l) => l.title && l.url);
  return { listings, totalCount, pageSize };
}

// ── Detail extraction ─────────────────────────────────────────────────────────

export function extractQuestionsAndAnswers(bodyText: string): Array<{ question: string; answer: string }> {
  const start = bodyText.toLowerCase().indexOf('questions & answers');
  if (start === -1) return [];
  const lineEnd = bodyText.indexOf('\n', start);
  if (lineEnd === -1) return [];
  let after = bodyText.slice(lineEnd + 1).trimStart();
  if (after.startsWith('Ask a question\n')) after = after.slice('Ask a question\n'.length).trimStart();
  const afterLower = after.toLowerCase();
  const ends = ['ask a question', 'about the seller', 'about the store', "seller's other listings", 'similar listings', 'you might also like', 'back to top'];
  let end = after.length;
  for (const e of ends) {
    const idx = afterLower.indexOf(e);
    if (idx !== -1 && idx < end) end = idx;
  }
  const content = after.slice(0, end).trim();
  if (!content) return [];

  const lines = content.split('\n');
  const segments: string[] = [];
  const current: string[] = [];
  let i = 0;
  let foundAnyUsernames = false;
  while (i < lines.length) {
    if (i + 1 < lines.length && /\(\d+$/.test(lines[i].trim()) && lines[i + 1].trim().startsWith(') •')) {
      foundAnyUsernames = true;
      segments.push(current.splice(0).join('\n').trim());
      i += 2;
    } else {
      current.push(lines[i]);
      i++;
    }
  }
  if (current.length) segments.push(current.join('\n').trim());

  if (!foundAnyUsernames) return [];

  const pairs: Array<{ question: string; answer: string }> = [];
  for (let j = 0; j < segments.length; j += 2) {
    const question = segments[j].trim();
    const answer = segments[j + 1]?.trim() ?? '';
    if (question) pairs.push({ question, answer });
  }
  return pairs;
}

export function extractDetails(bodyText: string): Array<{ key: string; value: string }> {
  const detailsStart = bodyText.indexOf('Details\n');
  if (detailsStart === -1) return [];
  const after = bodyText.slice(detailsStart + 'Details\n'.length);
  const ends = ['Description\n', 'Shipping & pick-up options'];
  let end = after.length;
  for (const e of ends) {
    const idx = after.indexOf(e);
    if (idx !== -1 && idx < end) end = idx;
  }
  const lines = after.slice(0, end).split('\n').map(l => l.trim()).filter(Boolean);
  const pairs: Array<{ key: string; value: string }> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push({ key: lines[i].replace(/:$/, ''), value: lines[i + 1] });
  }
  return pairs;
}

export function extractDescriptionFromText(bodyText: string): string {
  const marker = 'Description\n';
  const start = bodyText.indexOf(marker);
  if (start === -1) return '';
  const after = bodyText.slice(start + marker.length).trimStart();
  const afterLower = after.toLowerCase();
  const ends = ['\ndetails\n', 'shipping & pick-up options', 'questions & answers', "seller's other listings", 'similar listings', 'you might also like'];
  let end = after.length;
  for (const e of ends) {
    const idx = afterLower.indexOf(e);
    if (idx !== -1 && idx < end) end = idx;
  }
  return after.slice(0, end).replace(/\s*\nShow more\s*$/, '').trim();
}

export function extractStructuredFromText(bodyText: string): Partial<ListingDetail> {
  let buyNowPrice: number | null = null;
  const bnMatch = bodyText.match(/Buy [Nn]ow\s*\n\s*\$([\d,]+(?:\.\d+)?)/);
  if (bnMatch) buyNowPrice = parseFloat(bnMatch[1].replace(/,/g, ''));

  let reserveStatus = 'UNKNOWN';
  if (/No reserve/.test(bodyText)) reserveStatus = 'NONE';
  else if (/Reserve met/.test(bodyText)) reserveStatus = 'MET';
  else if (/Reserve not met/.test(bodyText)) reserveStatus = 'NOT_MET';

  const pickupMatch = bodyText.match(/Pick up from ([^\n]+)/);
  const pickupLocation = pickupMatch ? pickupMatch[1].trim() : '';
  const shippingIdx = bodyText.indexOf('Shipping & pick-up options');
  const shippingSection = shippingIdx >= 0 ? bodyText.slice(shippingIdx) : '';
  const isPickupOnly =
    /Pick-?up only|pickup only/i.test(bodyText) ||
    (pickupLocation !== '' && !/North Island|South Island|NZ Post|Courier/i.test(shippingSection));
  const shippingAvailable = !isPickupOnly;
  const pickupAvailable = pickupLocation !== '';

  return { buyNowPrice, reserveStatus, shippingAvailable, pickupAvailable, pickupLocation };
}

// ── GraphQL extraction ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAttr(attrs: any[], key: string): any {
  return attrs.find((a) => a.key === key);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFromGraphQL(json: any): Partial<ListingDetail> {
  const listing = json?.data?.listing;
  if (!listing?.attributes) return {};
  const attrs = listing.attributes;
  const buyNowAttr = extractAttr(attrs, 'BuyNowPrice');
  const deliveryAttr = extractAttr(attrs, 'DeliveryOptions');
  const buyNowPrice: number | null = buyNowAttr?.numValue ?? null;
  const deliveryOptions: { __typename: string; name: string }[] = deliveryAttr?.options ?? [];
  const hasShipping = deliveryOptions.some((o) => o.__typename !== 'PickupOption');
  const pickupOption = deliveryOptions.find((o) => o.__typename === 'PickupOption');
  const pickupLocation = pickupOption?.name?.replace(/^Pick up from\s*/i, '') ?? '';
  const reserveStatus: string =
    listing?.contentViews?.listingPurchaseContentCard?.auctionDetails?.reserveStatus ?? 'UNKNOWN';
  const pickupAvailable = pickupOption !== undefined;
  return { buyNowPrice, reserveStatus, shippingAvailable: hasShipping, pickupAvailable, pickupLocation };
}

// ── Playwright helpers ────────────────────────────────────────────────────────

function waitForSearchApiResponse(page: Page): Promise<{ listings: Listing[]; totalCount: number; pageSize: number }> {
  return new Promise((resolve) => {
    const handler = async (response: Response) => {
      if (response.url().includes('api.trademe.co.nz/v1/search') && response.status() === 200) {
        page.off('response', handler);
        try {
          resolve(parseSearchApiResponse(await response.json() as Record<string, unknown>));
        } catch {
          resolve({ listings: [], totalCount: 0, pageSize: 1 });
        }
      }
    };
    page.on('response', handler);
    setTimeout(() => { page.off('response', handler); resolve({ listings: [], totalCount: 0, pageSize: 1 }); }, 12000);
  });
}

export async function fetchSingleListingDetail(page: Page, url: string): Promise<ListingDetail> {
  let graphqlResult: Partial<ListingDetail> = {};

  const handler = async (response: Response) => {
    if (!response.url().includes('api.trademe.co.nz/graphql') || response.status() !== 200) return;
    try {
      const json = await response.json();
      const extracted = extractFromGraphQL(json);
      if (Object.keys(extracted).length > 0) {
        page.off('response', handler);
        graphqlResult = extracted;
      }
    } catch { /* ignore */ }
  };
  page.on('response', handler);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  page.off('response', handler);

  const bodyText: string = await page.evaluate(() => document.body.innerText);
  const details = extractDetails(bodyText);
  const description = extractDescriptionFromText(bodyText);
  const dom = extractStructuredFromText(bodyText);
  const questionsAndAnswers = extractQuestionsAndAnswers(bodyText);

  return {
    details,
    description,
    buyNowPrice: graphqlResult.buyNowPrice ?? dom.buyNowPrice ?? null,
    reserveStatus:
      graphqlResult.reserveStatus && graphqlResult.reserveStatus !== 'UNKNOWN'
        ? graphqlResult.reserveStatus
        : (dom.reserveStatus ?? 'UNKNOWN'),
    shippingAvailable: graphqlResult.shippingAvailable ?? dom.shippingAvailable ?? null,
    pickupAvailable: graphqlResult.pickupAvailable ?? dom.pickupAvailable ?? null,
    pickupLocation: graphqlResult.pickupLocation || dom.pickupLocation || '',
    questionsAndAnswers,
  };
}

// ── Recipe implementation ─────────────────────────────────────────────────────

async function quickSearch(
  searchUrl: string,
  onEvent: (event: QuickSearchEvent) => void
): Promise<void> {
  onEvent({ type: 'criteria', filters: extractImplicitFilters(searchUrl) });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
  const page = await context.newPage();

  try {
    onEvent({ type: 'progress', message: 'Fetching page 1…' });
    const p1Promise = waitForSearchApiResponse(page);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const { listings: p1Listings, totalCount, pageSize } = await p1Promise;
    const totalPages = Math.ceil(totalCount / pageSize);

    onEvent({ type: 'progress', message: `${totalCount} results across ${totalPages} page${totalPages !== 1 ? 's' : ''}` });

    let found = 0;
    const seenUrls = new Set<string>();
    const emit = (listings: Listing[]) => {
      for (const l of listings) {
        if (seenUrls.has(l.url)) continue;
        seenUrls.add(l.url);
        found++;
        onEvent({ type: 'listing', data: l });
      }
    };

    emit(p1Listings);

    for (let p = 2; p <= totalPages; p++) {
      await page.waitForSelector('a[aria-label^="Next page"]', { timeout: 8000 }).catch(() => null);
      const next = page.locator('a[aria-label^="Next page"]').first();
      if (!await next.isVisible({ timeout: 3000 }).catch(() => false)) break;

      onEvent({ type: 'progress', message: `Fetching page ${p}/${totalPages}…` });
      const nextPromise = waitForSearchApiResponse(page);
      await next.click();
      const { listings: nextListings } = await nextPromise;
      if (nextListings.length === 0) break;
      emit(nextListings);
      await page.waitForTimeout(500);
    }

    onEvent({ type: 'complete' });
  } catch (err) {
    onEvent({ type: 'error', message: (err as Error).message });
  } finally {
    await browser.close();
  }
}

async function deepSearch(
  listings: Listing[],
  onEvent: (event: DeepSearchEvent) => void
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });
  const page = await context.newPage();

  try {
    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      onEvent({ type: 'progress', index: i + 1, total: listings.length, title: listing.title });
      const detail = await fetchSingleListingDetail(page, listing.url);
      onEvent({ type: 'detail', url: listing.url, detail });
      if (i < listings.length - 1) await page.waitForTimeout(500);
    }
    onEvent({ type: 'complete' });
  } catch (err) {
    onEvent({ type: 'error', message: (err as Error).message });
  } finally {
    await browser.close();
  }
}

export const trademeRecipe: Recipe = {
  name: 'trademe',
  matches(url: string): boolean {
    try { return new URL(url).hostname.endsWith('trademe.co.nz'); }
    catch { return false; }
  },
  extractImplicitFilters,
  quickSearch,
  deepSearch,
};
