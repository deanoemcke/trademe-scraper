import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type { Recipe, Listing, ListingDetail, QuickSearchEvent, DeepSearchEvent } from './base';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FACEBOOK_BASE = 'https://www.facebook.com';

// ── Implicit filter extraction ────────────────────────────────────────────────

export function extractImplicitFilters(urlStr: string): Array<[string, string]> {
  try {
    const url = new URL(urlStr);
    const rows: Array<[string, string]> = [];

    const query = url.searchParams.get('query');
    if (query) rows.push(['Search', `"${query}"`]);

    const minPrice = url.searchParams.get('minPrice');
    const maxPrice = url.searchParams.get('maxPrice');
    if (minPrice && maxPrice) rows.push(['Price', `$${minPrice} – $${maxPrice}`]);
    else if (minPrice) rows.push(['Min Price', `$${minPrice}`]);
    else if (maxPrice) rows.push(['Max Price', `$${maxPrice}`]);

    const condition = url.searchParams.get('itemCondition');
    if (condition) rows.push(['Condition', condition]);

    const daysSinceListed = url.searchParams.get('daysSinceListed');
    if (daysSinceListed) rows.push(['Listed within', `${daysSinceListed} days`]);

    const sortBy = url.searchParams.get('sortBy');
    if (sortBy) rows.push(['Sort', sortBy]);

    return rows;
  } catch {
    return [];
  }
}

// ── Browser context ───────────────────────────────────────────────────────────

async function createContext(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-NZ' });

  // FB_COOKIES: JSON array of cookies exported from your browser (e.g. via the
  // "Cookie Editor" extension — Export > Export as JSON).
  const cookiesJson = process.env.FB_COOKIES;
  if (cookiesJson) {
    try {
      const raw = JSON.parse(cookiesJson) as Array<Record<string, unknown>>;
      await context.addCookies(raw.map(c => ({
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain ?? '.facebook.com'),
        path: String(c.path ?? '/'),
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        sameSite: (['Strict', 'Lax', 'None'].includes(String(c.sameSite)) ? c.sameSite : 'Lax') as 'Strict' | 'Lax' | 'None',
        ...(typeof c.expirationDate === 'number' ? { expires: c.expirationDate } :
            typeof c.expires === 'number' ? { expires: c.expires } : {}),
      })));
      console.log(`[facebook] loaded ${raw.length} cookies from FB_COOKIES`);
    } catch (err) {
      console.log('[facebook] Failed to parse FB_COOKIES:', err);
    }
  }

  return { browser, context };
}

async function maskHeadless(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // @ts-ignore
    if (!window.chrome) window.chrome = { runtime: {} };
  });
}

// ── Listing card extraction ───────────────────────────────────────────────────

interface RawListing {
  id: string;
  url: string;
  thumbnailUrl?: string;
  title: string;
  price: string;
  location: string;
}

async function extractListingsFromPage(page: Page, seen: Set<string>): Promise<RawListing[]> {
  const newListings = await page.evaluate((base) => {
    // Matches NZ$800, $800, US$800, A$800, Free — any currency prefix
    const priceRe = /^(?:[A-Z]{0,3}\$)[\d,]+(?:\.\d{2})?$|^Free$/;

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/marketplace/item/"]'));
    const results: Array<{
      id: string; url: string; thumbnailUrl?: string;
      title: string; price: string; location: string;
    }> = [];

    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      const match = href.match(/\/marketplace\/item\/(\d+)\//);
      if (!match) continue;

      const img = link.querySelector('img');
      const thumbnailUrl = img?.src || undefined;

      // Price from innerText: handles NZ$ prefix and the strikethrough original price.
      // innerText order is always [currentPrice, originalPrice?, title, location].
      const innerLines = (link.innerText ?? '')
        .split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);
      const priceLines = innerLines.filter((l: string) => priceRe.test(l));
      const price = priceLines.length === 0 ? 'Price on request'
                  : priceLines.length >= 2  ? `${priceLines[0]} <s>${priceLines[1]}</s>`
                  : priceLines[0];

      let title = '', location = 'Unknown';

      // Primary: aria-label → "{title}, {currentPrice}, {location}, listing {id}"
      // Always contains only the current price, so use innerText prices above instead.
      const ariaLabel = (link.getAttribute('aria-label') ?? '')
        .replace(/,\s*listing\s+\d+\s*$/i, '').trim();
      const labelMatch = ariaLabel.match(/^(.+?),\s*(?:[A-Z]{0,3}\$[\d,]+(?:\.\d{2})?|Free),\s*(.+)$/);
      if (labelMatch) {
        title    = labelMatch[1].trim();
        location = labelMatch[2].trim();
      }

      // Fallback: innerText for title and location
      if (!title) {
        location = innerLines[innerLines.length - 1] ?? 'Unknown';
        title    = innerLines.find((l: string) => !priceRe.test(l) && l !== location) ?? '';
      }

      if (!title) continue;

      results.push({ id: match[1], url: `${base}/marketplace/item/${match[1]}/`, thumbnailUrl, title, price, location, isAuction: false });
    }

    return results;
  }, FACEBOOK_BASE);

  return newListings.filter(l => !seen.has(l.id));
}

// ── Quick search ──────────────────────────────────────────────────────────────

async function quickSearch(searchUrl: string, onEvent: (event: QuickSearchEvent) => void): Promise<void> {
  onEvent({ type: 'criteria', filters: extractImplicitFilters(searchUrl) });

  let browser: Browser | undefined;
  try {
    const ctx = await createContext();
    browser = ctx.browser;
    const page = await ctx.context.newPage();
    await maskHeadless(page);

    onEvent({ type: 'progress', message: 'Loading Facebook Marketplace…' });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[facebook] loaded — url: ${page.url()}`);

    // Dismiss cookie consent if present
    const cookieBtn = page.locator('[aria-label="Allow all cookies"], [title="Allow all cookies"], [data-cookiebanner="accept_button"]');
    if (await cookieBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await cookieBtn.first().click();
      await page.waitForTimeout(1000);
    }

    // Wait for listings to render, or detect a login/block state
    const listingsAppeared = await page.waitForSelector('a[href*="/marketplace/item/"]', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    console.log(`[facebook] listingsAppeared: ${listingsAppeared} — url: ${page.url()}`);

    if (!listingsAppeared) {
      const bodySnippet = await page.evaluate(() => document.body.innerText).catch(() => '(evaluate failed)');
      const snippet = bodySnippet.slice(0, 300);
      console.log(`[facebook] page text snippet:\n${snippet}`);
      const isLoginWall = page.url().includes('/login')
        || snippet.toLowerCase().includes('log in') || snippet.toLowerCase().includes('sign up');
      onEvent({
        type: 'error',
        message: isLoginWall
          ? 'Facebook requires login. Set FB_EMAIL and FB_PASSWORD environment variables.'
          : 'No listings found. Facebook may be blocking access or the search returned no results.',
      });
      return;
    }

    const seen = new Set<string>();
    let totalEmitted = 0;

    const emit = (listings: RawListing[]) => {
      for (const l of listings) {
        seen.add(l.id);
        totalEmitted++;
        onEvent({ type: 'listing', data: { title: l.title, price: l.price, location: l.location, url: l.url, thumbnailUrl: l.thumbnailUrl } });
      }
    };

    // Emit first batch immediately
    const first = await extractListingsFromPage(page, seen);
    console.log(`[facebook] first batch: ${first.length} listings`);
    if (first.length === 0) {
      const linkCount = await page.$$eval('a[href*="/marketplace/item/"]', ls => ls.length).catch(() => 0);
      const sample = await page.$eval('a[href*="/marketplace/item/"]', (a: Element) => ({
        href: a.getAttribute('href'),
        ariaLabel: a.getAttribute('aria-label'),
        text: (a as HTMLElement).innerText?.slice(0, 200),
      })).catch(() => null);
      console.log(`[facebook] ${linkCount} item links but 0 extracted. Sample:`, sample);
    }
    emit(first);
    if (first.length > 0) onEvent({ type: 'progress', message: `Found ${totalEmitted} listings…` });

    // Scroll to load more
    let noNewCount = 0;
    for (;;) {
      const bodyText: string = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes('Results from outside your search')) break;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);

      const batch = await extractListingsFromPage(page, seen);
      emit(batch);

      if (batch.length === 0) {
        if (++noNewCount >= 2) break;
      } else {
        noNewCount = 0;
        onEvent({ type: 'progress', message: `Found ${totalEmitted} listings, loading more…` });
      }
    }

    console.log(`[facebook] complete — ${totalEmitted} listings emitted`);
    onEvent({ type: 'complete' });
  } catch (err) {
    console.log(`[facebook] error:`, err);
    onEvent({ type: 'error', message: (err as Error).message });
  } finally {
    await browser?.close();
  }
}

// ── Detail extraction ─────────────────────────────────────────────────────────

export function extractFBDescription(bodyText: string): string {
  // Description sits after the Details section's key-value pairs and before "See more"
  const detailsIdx = bodyText.indexOf('\nDetails\n');
  if (detailsIdx === -1) return '';
  const afterDetails = bodyText.slice(detailsIdx + '\nDetails\n'.length);

  let end = afterDetails.length;
  const seeMoreIdx = afterDetails.indexOf('\nSee more\n');
  if (seeMoreIdx !== -1) end = Math.min(end, seeMoreIdx);
  const approxIdx = afterDetails.search(/\n.+·\s*Location is approximate/);
  if (approxIdx !== -1) end = Math.min(end, approxIdx);

  const lines = afterDetails.slice(0, end)
    .split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Skip leading detail key-value pairs (short lines, no sentence-ending punctuation)
  let i = 0;
  while (i < lines.length && lines[i].length < 30 && !/[.!?]/.test(lines[i])) i++;

  return lines.slice(i).join('\n').trim();
}

export function extractFBDetails(bodyText: string): Array<{ key: string; value: string }> {
  const details: Array<{ key: string; value: string }> = [];
  const detailsIdx = bodyText.indexOf('\nDetails\n');
  if (detailsIdx === -1) return [];

  const lines = bodyText
    .slice(detailsIdx + '\nDetails\n'.length)
    .split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let i = 0;
  while (i + 1 < lines.length) {
    const key = lines[i];
    const val = lines[i + 1];
    // A detail pair: key is short/simple, value is short/simple (not prose)
    if (key.length < 30 && !/[.!?]/.test(key) && val.length < 60 && !/[.!?]{2}/.test(val)) {
      details.push({ key, value: val });
      i += 2;
    } else {
      break;
    }
  }

  return details;
}

async function fetchFBListingDetail(page: Page, url: string): Promise<ListingDetail> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Expand truncated description if "See more" is present
  const seeMoreBtn = page.getByRole('button', { name: 'See more' }).first();
  if (await seeMoreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await seeMoreBtn.click();
    await page.waitForTimeout(500);
  }

  const bodyText: string = await page.evaluate(() => document.body.innerText);

  // First price in page = current price; strikethrough original appears second in DOM order
  const priceMatch = bodyText.match(/(?:[A-Z]{0,3}\$)([\d,]+(?:\.\d{2})?)/);
  const buyNowPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;

  const details = extractFBDetails(bodyText);
  const description = extractFBDescription(bodyText);

  const locationMatch = bodyText.match(/Listed in ([^\n·]+)/);
  const pickupLocation = locationMatch?.[1]?.trim() ?? '';

  return {
    details,
    description,
    buyNowPrice,
    reserveStatus: 'NONE',
    shippingAvailable: null,
    pickupAvailable: null,
    pickupLocation,
    questionsAndAnswers: [],
  };
}

// ── Deep search ───────────────────────────────────────────────────────────────

async function deepSearch(listings: Listing[], onEvent: (event: DeepSearchEvent) => void): Promise<void> {
  let browser: Browser | undefined;
  try {
    const ctx = await createContext();
    browser = ctx.browser;
    const page = await ctx.context.newPage();
    await maskHeadless(page);

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      onEvent({ type: 'progress', index: i + 1, total: listings.length, title: listing.title });
      const detail = await fetchFBListingDetail(page, listing.url);
      onEvent({ type: 'detail', url: listing.url, detail });
      if (i < listings.length - 1) await page.waitForTimeout(500);
    }
    onEvent({ type: 'complete' });
  } catch (err) {
    onEvent({ type: 'error', message: (err as Error).message });
  } finally {
    await browser?.close();
  }
}

// ── Recipe ────────────────────────────────────────────────────────────────────

export const facebookRecipe: Recipe = {
  name: 'facebook',
  matches(url: string): boolean {
    try {
      const { hostname, pathname } = new URL(url);
      return hostname.endsWith('facebook.com') && pathname.includes('/marketplace/');
    } catch {
      return false;
    }
  },
  extractImplicitFilters,
  quickSearch,
  deepSearch,
};
