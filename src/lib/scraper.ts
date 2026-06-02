import { chromium, Page, Response } from 'playwright';

export interface Listing {
  title: string;
  price: string;
  location: string;
  url: string;
  thumbnailUrl?: string;
  allowsPickups?: number; // 1 = shipping only, 2 = pickup only, 3 = both
  description?: string;  // populated after deep search
}

export interface ListingDetail {
  details: Array<{ key: string; value: string }>;
  description: string;
  buyNowPrice: number | null;
  reserveStatus: string;
  pickupOnly: boolean;
  pickupLocation: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
}

export interface FilterCriteria {
  minPrice?: number;
  maxPrice?: number;
  keywords?: string[];
  excludeKeywords?: string[];
}

export type QuickSearchEvent =
  | { type: 'progress'; message: string }
  | { type: 'listing'; data: Listing }
  | { type: 'complete'; found: number; filtered: number }
  | { type: 'error'; message: string };

export type DeepSearchEvent =
  | { type: 'progress'; index: number; total: number; title: string }
  | { type: 'detail'; url: string; detail: ListingDetail }
  | { type: 'complete' }
  | { type: 'error'; message: string };

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TRADEME_BASE = 'https://www.trademe.co.nz/a';

type ApiItem = Record<string, unknown>;

function priceToNumber(raw: string): number | null {
  const match = raw.replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

export function applyFilters(listing: Listing, filters: FilterCriteria): boolean {
  const titleLower = listing.title.toLowerCase();
  if (filters.keywords?.length) {
    if (!filters.keywords.every((kw) => titleLower.includes(kw.toLowerCase()))) return false;
  }
  if (filters.excludeKeywords?.length) {
    if (filters.excludeKeywords.some((kw) => titleLower.includes(kw.toLowerCase()))) return false;
  }
  const price = priceToNumber(listing.price);
  if (price !== null) {
    if (filters.minPrice !== undefined && price < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && price > filters.maxPrice) return false;
  }

  return true;
}

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
    }))
    .filter((l) => l.title && l.url);
  return { listings, totalCount, pageSize };
}

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
  return { buyNowPrice, reserveStatus, pickupOnly: !hasShipping, pickupLocation };
}

export function extractQuestionsAndAnswers(bodyText: string): Array<{ question: string; answer: string }> {
  // Heading varies: "Questions & answers", "Questions & Answers (5)", etc.
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

  // Split into text segments by stripping username+timestamp pairs.
  // Each pair is two lines: "username (N" followed by ") • timestamp".
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

  // If we didn't find any Q&A pairs (no username lines), return empty
  if (!foundAnyUsernames) return [];

  // Segments alternate Q, A, Q, A …
  const pairs: Array<{ question: string; answer: string }> = [];
  for (let j = 0; j < segments.length; j += 2) {
    const question = segments[j].trim();
    const answer = segments[j + 1]?.trim() ?? '';
    if (question) pairs.push({ question, answer });
  }
  return pairs;
}

export function extractDetails(bodyText: string): Array<{ key: string; value: string }> {
  // Details section appears before Description in TradeMe page layout
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
    // Keys are formatted "Label:" with a trailing colon
    pairs.push({ key: lines[i].replace(/:$/, ''), value: lines[i + 1] });
  }
  return pairs;
}

export function extractDescriptionFromText(bodyText: string): string {
  const marker = 'Description\n';
  const start = bodyText.indexOf(marker);
  if (start === -1) return '';
  const after = bodyText.slice(start + marker.length).trimStart();
  // Case-insensitive end matching — heading capitalisation varies (e.g. "Questions & Answers (5)")
  const afterLower = after.toLowerCase();
  const ends = ['details', 'shipping & pick-up options', 'questions & answers', "seller's other listings", 'similar listings', 'you might also like'];
  let end = after.length;
  for (const e of ends) {
    const idx = afterLower.indexOf(e);
    if (idx !== -1 && idx < end) end = idx;
  }
  // Strip trailing "Show more" UI text TradeMe injects before the shipping section
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
  const pickupOnly =
    /Pick-?up only|pickup only/i.test(bodyText) ||
    (pickupLocation !== '' && !/North Island|South Island|NZ Post|Courier/i.test(shippingSection));

  return { buyNowPrice, reserveStatus, pickupOnly, pickupLocation };
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
    pickupOnly: graphqlResult.pickupOnly ?? dom.pickupOnly ?? false,
    pickupLocation: graphqlResult.pickupLocation || dom.pickupLocation || '',
    questionsAndAnswers,
  };
}

export async function quickSearch(
  searchUrl: string,
  filters: FilterCriteria,
  onEvent: (event: QuickSearchEvent) => void
): Promise<void> {
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
    let filtered = 0;
    const seenUrls = new Set<string>();
    const emit = (listings: Listing[]) => {
      for (const l of listings) {
        if (seenUrls.has(l.url)) continue;
        seenUrls.add(l.url);
        found++;
        if (applyFilters(l, filters)) { filtered++; onEvent({ type: 'listing', data: l }); }
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

    onEvent({ type: 'complete', found, filtered });
  } catch (err) {
    onEvent({ type: 'error', message: (err as Error).message });
  } finally {
    await browser.close();
  }
}

export async function deepSearch(
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
