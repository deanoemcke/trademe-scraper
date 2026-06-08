import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type { Recipe, Listing, ListingDetail, QuickSearchEvent, DeepSearchEvent } from './base';
import { RECIPE_PATTERNS } from './metadata';
import { enqueue } from '../queue';

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

// ── Listing extraction via MutationObserver ───────────────────────────────────

const PRICE_RE = /^(?:[A-Z]{0,3}\$)[\d,]+(?:\.\d{2})?$|^Free$/;

export function parseFacebookPriceLines(innerText: string): { price: number | null; priceDisplay: string } {
  const lines = innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const priceLines = lines.filter(l => PRICE_RE.test(l));
  const priceDisplay = priceLines.length === 0 ? 'Price on request' : priceLines[0];
  const priceMatch = priceLines[0]?.replace(/,/g, '').match(/[\d.]+/);
  const price = priceMatch ? parseFloat(priceMatch[0]) : null;
  return { price, priceDisplay };
}

// Called from browser-side MutationObserver via page.exposeFunction.
// Runs in Node.js; returns void (browser side fire-and-forgets).
type RawListingMsg = { id: string; url: string; ariaLabel: string; innerText: string; thumbnailUrl: string };

function processRawListing(
  raw: RawListingMsg,
  seen: Set<string>,
  onEvent: (event: QuickSearchEvent) => void,
  counter: { total: number },
): void {
  if (seen.has(raw.id)) return;
  seen.add(raw.id);

  const { price, priceDisplay } = parseFacebookPriceLines(raw.innerText);
  const innerLines = raw.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let title = '', location = 'Unknown';
  const ariaLabel = raw.ariaLabel.replace(/,\s*listing\s+\d+\s*$/i, '').trim();
  const labelMatch = ariaLabel.match(/^(.+?),\s*(?:[A-Z]{0,3}\$[\d,]+(?:\.\d{2})?|Free),\s*(.+)$/);
  if (labelMatch) {
    title    = labelMatch[1].trim();
    location = labelMatch[2].trim();
  }
  if (!title) {
    location = innerLines[innerLines.length - 1] ?? 'Unknown';
    title    = innerLines.find(l => !PRICE_RE.test(l) && l !== location) ?? '';
  }
  if (!title) return;

  counter.total++;
  onEvent({ type: 'listing', data: { title, price, priceDisplay, location, url: raw.url, thumbnailUrl: raw.thumbnailUrl || undefined, isAuction: false } });
}

// ── Quick search ──────────────────────────────────────────────────────────────

async function quickSearch(searchUrl: string, onEvent: (event: QuickSearchEvent) => void, isCancelled?: () => boolean): Promise<void> {
  onEvent({ type: 'criteria', filters: extractImplicitFilters(searchUrl) });

  let browser: Browser | undefined;
  try {
    const ctx = await createContext();
    browser = ctx.browser;
    const page = await ctx.context.newPage();
    await maskHeadless(page);

    const seen = new Set<string>();
    const counter = { total: 0 };

    // Bridge: browser → Node.js. Called by the MutationObserver for every new listing link.
    await page.exposeFunction('fbListingFound', (raw: RawListingMsg) => {
      processRawListing(raw, seen, onEvent, counter);
    });

    onEvent({ type: 'progress', message: 'Loading Facebook Marketplace…' });
    console.log(`[facebook] fetching: ${searchUrl}`);
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
      const snippet = await page.evaluate(() => document.body.innerText).catch(() => '').then(t => t.slice(0, 300));
      console.log(`[facebook] page text snippet:\n${snippet}`);
      const isLoginWall = page.url().includes('/login')
        || snippet.toLowerCase().includes('log in') || snippet.toLowerCase().includes('sign up');
      onEvent({
        type: 'error',
        message: isLoginWall
          ? 'Facebook requires login. Set FB_COOKIES environment variable.'
          : 'No listings found. Facebook may be blocking access or the search returned no results.',
      });
      return;
    }

    // Inject MutationObserver — captures every listing link the moment it enters the DOM,
    // before virtualisation can remove it. Also processes all already-rendered links.
    await page.evaluate((base: string) => {
      function processLink(link: Element) {
        const href = link.getAttribute('href') ?? '';
        const match = href.match(/\/marketplace\/item\/(\d+)\//);
        if (!match) return;
        const img = link.querySelector('img');
        (window as any).fbListingFound({
          id: match[1],
          url: `${base}/marketplace/item/${match[1]}/`,
          ariaLabel: link.getAttribute('aria-label') ?? '',
          innerText: (link as HTMLElement).innerText ?? '',
          thumbnailUrl: img ? (img as HTMLImageElement).src : '',
        });
      }

      document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(processLink);

      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node as Element;
            if (el.matches('a[href*="/marketplace/item/"]')) processLink(el);
            el.querySelectorAll('a[href*="/marketplace/item/"]').forEach(processLink);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, FACEBOOK_BASE);

    console.log(`[facebook] observer injected — initial: ${counter.total} listings`);
    if (counter.total > 0) onEvent({ type: 'progress', message: `Found ${counter.total} listings…` });

    // The login wall modal is present in the DOM from page load — check immediately after
    // the observer fires so we can skip the scroll loop and report the partial results.
    const loginWallDetected = await page.evaluate(() => {
      return (
        !!document.getElementById('login_popup_cta_form') ||
        !!document.querySelector('form[action*="/login/device-based/"]') ||
        !!document.querySelector('input[name="email"]') ||
        !!document.querySelector('input[name="pass"]')
      );
    }).catch(() => false);

    console.log(`[facebook] loginWallDetected: ${loginWallDetected}`);

    if (loginWallDetected) {
      console.log(`[facebook] login wall detected — only ${counter.total} listings available`);
      onEvent({
        type: 'error',
        message: `Login wall detected — only ${counter.total} listing${counter.total !== 1 ? 's' : ''} loaded. Set the FB_COOKIES environment variable to get full results.`,
      });
      return;
    }

    // Scroll loop — just drives scrolling; extraction is handled by the observer above
    let noNewCount = 0;
    let lastTotal = 0;
    for (;;) {
      if (isCancelled?.()) break;
      const bodyText: string = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes('Results from outside your search')) break;

      // Simulate real scroll events — window.scrollTo alone doesn't trigger FB's
      // infinite scroll listener; mouse wheel + End key are more reliable.
      await page.mouse.wheel(0, 3000);
      await page.keyboard.press('End');
      await page.waitForTimeout(1500);

      if (counter.total > lastTotal) {
        onEvent({ type: 'progress', message: `Found ${counter.total} listings, loading more…` });
        noNewCount = 0;
        lastTotal = counter.total;
      } else {
        if (++noNewCount >= 5) break;
      }
    }

    console.log(`[facebook] complete — ${counter.total} listings emitted`);
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
  console.log(`[facebook] fetching: ${url}`);
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

async function deepSearch(listings: Listing[], onEvent: (event: DeepSearchEvent) => void, isCancelled?: () => boolean): Promise<void> {
  let browser: Browser | undefined;
  try {
    const ctx = await createContext();
    browser = ctx.browser;

    await Promise.all(
      listings.map((listing, i) =>
        enqueue(listing.url, async () => {
          const pg = await ctx.context.newPage();
          if (isCancelled?.()) { await pg.close(); return; }
          await maskHeadless(pg);
          try {
            onEvent({ type: 'progress', index: i + 1, total: listings.length, title: listing.title });
            const detail = await fetchFBListingDetail(pg, listing.url);
            onEvent({ type: 'detail', url: listing.url, detail });
          } finally {
            await pg.close();
          }
        })
      )
    );
    onEvent({ type: 'complete' });
  } catch (err) {
    onEvent({ type: 'error', message: (err as Error).message });
  } finally {
    await browser?.close();
  }
}

// ── Recipe ────────────────────────────────────────────────────────────────────

const facebookPattern = RECIPE_PATTERNS.find(p => p.name === 'facebook')!;

export const facebookRecipe: Recipe = {
  name: facebookPattern.name,
  matches(url: string): boolean {
    try {
      const { hostname, pathname } = new URL(url);
      return hostname.endsWith(facebookPattern.hostname) && pathname.includes(facebookPattern.pathPrefix!);
    } catch {
      return false;
    }
  },
  extractImplicitFilters,
  quickSearch,
  deepSearch,
};
