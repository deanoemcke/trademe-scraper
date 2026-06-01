import express from 'express';
import path from 'path';
import fs from 'fs';
import { quickSearch, deepSearch, Listing, ListingDetail } from './lib/scraper';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Cache ─────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DISK_CACHE = process.env.CACHE_DISK === 'true';
const DISK_CACHE_PATH = path.join(__dirname, '../.cache/cache.json');

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const searchCache = new Map<string, CacheEntry<Listing[]>>();
const detailCache = new Map<string, CacheEntry<ListingDetail>>();

function isFresh<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function cacheAge(entry: CacheEntry<unknown>): string {
  const mins = Math.floor((Date.now() - entry.cachedAt) / 60000);
  return mins === 0 ? 'less than a minute ago' : `${mins} minute${mins !== 1 ? 's' : ''} ago`;
}

// Load from disk on startup (testing mode only)
if (DISK_CACHE) {
  try {
    const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf8');
    const saved = JSON.parse(raw) as {
      searches?: Record<string, CacheEntry<Listing[]>>;
      details?: Record<string, CacheEntry<ListingDetail>>;
    };
    let searches = 0, details = 0;
    for (const [url, entry] of Object.entries(saved.searches ?? {})) {
      searchCache.set(url, entry); searches++;
    }
    for (const [url, entry] of Object.entries(saved.details ?? {})) {
      detailCache.set(url, entry); details++;
    }
    console.log(`[cache] loaded from disk — ${searches} searches, ${details} listing details`);
  } catch {
    console.log('[cache] disk cache enabled — no existing cache file found');
  }
}

function saveToDisk(): void {
  if (!DISK_CACHE) return;
  fs.mkdirSync(path.dirname(DISK_CACHE_PATH), { recursive: true });
  fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify({
    searches: Object.fromEntries(searchCache),
    details: Object.fromEntries(detailCache),
  }, null, 2));
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
let isBusy = false;

function startSSE(res: express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sse(res: express.Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Quick search ──────────────────────────────────────────────────────────────
app.post('/api/quick-search', async (req, res) => {
  const { url } = req.body as { url: string };
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }

  const cached = searchCache.get(url);
  if (cached && isFresh(cached)) {
    console.log(`[cache] search hit (${cacheAge(cached)})`);
    startSSE(res);
    sse(res, { type: 'progress', message: `Loaded from cache (${cacheAge(cached)})` });
    for (const listing of cached.data) {
      sse(res, { type: 'listing', data: listing });
    }
    sse(res, { type: 'complete', found: cached.data.length, filtered: cached.data.length });
    res.end();
    return;
  }

  if (isBusy) {
    res.status(429).json({ error: 'A search is already in progress — please wait.' });
    return;
  }

  isBusy = true;
  startSSE(res);

  const listings: Listing[] = [];
  try {
    await quickSearch(url, {}, (event) => {
      if (event.type === 'listing') listings.push(event.data);
      sse(res, event);
    });
    if (listings.length > 0) {
      searchCache.set(url, { data: listings, cachedAt: Date.now() });
      saveToDisk();
      console.log(`[cache] stored ${listings.length} listings`);
    }
  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
  } finally {
    isBusy = false;
    res.end();
  }
});

// ── Deep search ───────────────────────────────────────────────────────────────
app.post('/api/deep-search', async (req, res) => {
  const { listings } = req.body as { listings: Listing[] };
  if (!Array.isArray(listings) || listings.length === 0) {
    res.status(400).json({ error: 'listings array is required' });
    return;
  }

  const fromCache: { url: string; detail: ListingDetail }[] = [];
  const toScrape: Listing[] = [];

  for (const listing of listings) {
    const cached = detailCache.get(listing.url);
    if (cached && isFresh(cached)) {
      fromCache.push({ url: listing.url, detail: cached.data });
    } else {
      toScrape.push(listing);
    }
  }

  if (toScrape.length === 0) {
    console.log(`[cache] detail hit for all ${listings.length} listings`);
    startSSE(res);
    for (const { url, detail } of fromCache) {
      sse(res, { type: 'detail', url, detail });
    }
    sse(res, { type: 'complete' });
    res.end();
    return;
  }

  if (isBusy) {
    res.status(429).json({ error: 'A search is already in progress — please wait.' });
    return;
  }

  if (fromCache.length > 0) {
    console.log(`[cache] detail hit for ${fromCache.length}/${listings.length} listings`);
  }

  isBusy = true;
  startSSE(res);

  for (const { url, detail } of fromCache) {
    sse(res, { type: 'detail', url, detail });
  }

  try {
    await deepSearch(toScrape, (event) => {
      if (event.type === 'detail') {
        detailCache.set(event.url, { data: event.detail, cachedAt: Date.now() });
        saveToDisk();
      }
      sse(res, event);
    });
  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
  } finally {
    isBusy = false;
    res.end();
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(Number(PORT), () => {
  console.log(`TradeMe scraper running at http://localhost:${PORT}`);
  if (DISK_CACHE) console.log('[cache] disk caching enabled (.cache/cache.json)');
});
