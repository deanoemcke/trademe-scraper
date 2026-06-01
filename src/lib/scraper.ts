import { chromium, Page, Response } from 'playwright';

export interface Listing {
  title: string;
  price: string;
  location: string;
  url: string;
  thumbnailUrl?: string;
}

export interface ListingDetail {
  description: string;
  buyNowPrice: number | null;
  reserveStatus: string;
  pickupOnly: boolean;
  pickupLocation: string;
}

export interface FilterCriteria {
  minPrice?: number;
  maxPrice?: number;
  keywords?: string[];
  excludeKeywords?: string[];
  minYear?: number;
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
  if (filters.minYear !== undefined) {
    const years = [...listing.title.matchAll(/\b(20\d{2})\b/g)].map((m) => parseInt(m[1]));
    if (years.length > 0 && Math.max(...years) < filters.minYear) return false;
  }
  return true;
}

function parseSearchApiResponse(data: Record<string, unknown>): { listings: Listing[]; totalCount: number } {
  const items = (data?.List ?? []) as ApiItem[];
  const totalCount = (data?.TotalCount as number) ?? 0;
  const listings = items
    .map((item) => ({
      title: (item.Title as string) ?? '',
      price: (item.PriceDisplay as string) ?? 'Price on request',
      location: [(item.Suburb as string), (item.Region as string)].filter(Boolean).join(', ') || 'Unknown',
      url: (item.CanonicalPath as string) ? `${TRADEME_BASE}${item.CanonicalPath}` : '',
      thumbnailUrl: (item.PictureHref as string) || undefined,
    }))
    .filter((l) => l.title && l.url);
  return { listings, totalCount };
}

function waitForSearchApiResponse(page: Page): Promise<{ listings: Listing[]; totalCount: number }> {
  return new Promise((resolve) => {
    const handler = async (response: Response) => {
      if (response.url().includes('api.trademe.co.nz/v1/search') && response.status() === 200) {
        page.off('response', handler);
        try {
          resolve(parseSearchApiResponse(await response.json() as Record<string, unknown>));
        } catch {
          resolve({ listings: [], totalCount: 0 });
        }
      }
    };
    page.on('response', handler);
    setTimeout(() => { page.off('response', handler); resolve({ listings: [], totalCount: 0 }); }, 12000);
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

function extractDescriptionFromText(bodyText: string): string {
  const marker = 'Description\n';
  const start = bodyText.indexOf(marker);
  if (start === -1) return '';
  const after = bodyText.slice(start + marker.length).trimStart();
  const ends = ['Shipping & pick-up options', 'Questions & answers', "Seller's other listings", 'Similar listings', 'You might also like'];
  let end = after.length;
  for (const e of ends) {
    const idx = after.indexOf(e);
    if (idx !== -1 && idx < end) end = idx;
  }
  return after.slice(0, end).trim();
}

function extractStructuredFromText(bodyText: string): Partial<ListingDetail> {
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
  const description = extractDescriptionFromText(bodyText);
  const dom = extractStructuredFromText(bodyText);

  return {
    description,
    buyNowPrice: graphqlResult.buyNowPrice ?? dom.buyNowPrice ?? null,
    reserveStatus:
      graphqlResult.reserveStatus && graphqlResult.reserveStatus !== 'UNKNOWN'
        ? graphqlResult.reserveStatus
        : (dom.reserveStatus ?? 'UNKNOWN'),
    pickupOnly: graphqlResult.pickupOnly ?? dom.pickupOnly ?? false,
    pickupLocation: graphqlResult.pickupLocation || dom.pickupLocation || '',
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
    const { listings: p1Listings, totalCount } = await p1Promise;
    const totalPages = Math.ceil(totalCount / 56);

    onEvent({ type: 'progress', message: `${totalCount} results across ${totalPages} page${totalPages !== 1 ? 's' : ''}` });

    let found = 0;
    let filtered = 0;
    const emit = (listings: Listing[]) => {
      for (const l of listings) {
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
