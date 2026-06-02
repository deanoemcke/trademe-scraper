import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { quickSearch, deepSearch, type Listing, type ListingDetail } from './src/lib/scraper';

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;
const DISK_CACHE = process.env.CACHE_DISK === 'true';
const DISK_CACHE_PATH = path.resolve(__dirname, '.cache/cache.json');

interface CacheEntry<T> { data: T; cachedAt: number; }

const searchCache = new Map<string, CacheEntry<Listing[]>>();
const detailCache = new Map<string, CacheEntry<ListingDetail>>();

function isFresh<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function cacheAge(entry: CacheEntry<unknown>): string {
  const mins = Math.floor((Date.now() - entry.cachedAt) / 60000);
  return mins === 0 ? 'less than a minute ago' : `${mins} minute${mins !== 1 ? 's' : ''} ago`;
}

if (DISK_CACHE) {
  try {
    const saved = JSON.parse(fs.readFileSync(DISK_CACHE_PATH, 'utf8')) as {
      searches?: Record<string, CacheEntry<Listing[]>>;
      details?: Record<string, CacheEntry<ListingDetail>>;
    };
    let s = 0, d = 0;
    for (const [url, entry] of Object.entries(saved.searches ?? {})) { searchCache.set(url, entry); s++; }
    for (const [url, entry] of Object.entries(saved.details ?? {})) { detailCache.set(url, entry); d++; }
    console.log(`[cache] loaded from disk — ${s} searches, ${d} listing details`);
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

// ── SSE / body helpers ────────────────────────────────────────────────────────

let isBusy = false;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function startSSE(res: ServerResponse): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sse(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

// ── Vite config ───────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [{
    name: 'trademe-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'POST') { next(); return; }

        // ── Quick search ──────────────────────────────────────────────────────
        if (req.url === '/api/quick-search') {
          const body = await readBody(req).catch(() => null);
          const url = (body as { url?: string })?.url;
          if (!url) { sendJSON(res, 400, { error: 'url is required' }); return; }

          const cached = searchCache.get(url);
          if (cached && isFresh(cached)) {
            console.log(`[cache:memory] search hit (${cacheAge(cached)})`);
            startSSE(res);
            sse(res, { type: 'progress', message: `Loaded from cache (${cacheAge(cached)})` });
            for (const listing of cached.data) sse(res, { type: 'listing', data: listing });
            sse(res, { type: 'complete', found: cached.data.length, filtered: cached.data.length });
            res.end(); return;
          }

          if (isBusy) { sendJSON(res, 429, { error: 'A search is already in progress — please wait.' }); return; }

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
              console.log(`[cache:${DISK_CACHE ? 'disk' : 'memory'}] stored ${listings.length} listings`);
            }
          } catch (err) {
            sse(res, { type: 'error', message: (err as Error).message });
          } finally {
            isBusy = false;
            res.end();
          }
          return;
        }

        // ── Deep search ───────────────────────────────────────────────────────
        if (req.url === '/api/deep-search') {
          const body = await readBody(req).catch(() => null);
          const listings = (body as { listings?: Listing[] })?.listings;
          if (!Array.isArray(listings) || listings.length === 0) {
            sendJSON(res, 400, { error: 'listings array is required' }); return;
          }

          const fromCache: { url: string; detail: ListingDetail }[] = [];
          const toScrape: Listing[] = [];
          for (const listing of listings) {
            const cached = detailCache.get(listing.url);
            if (cached && isFresh(cached)) fromCache.push({ url: listing.url, detail: cached.data });
            else toScrape.push(listing);
          }

          if (toScrape.length === 0) {
            console.log(`[cache:memory] detail hit for all ${listings.length} listings`);
            startSSE(res);
            for (const { url, detail } of fromCache) sse(res, { type: 'detail', url, detail });
            sse(res, { type: 'complete' });
            res.end(); return;
          }

          if (isBusy) { sendJSON(res, 429, { error: 'A search is already in progress — please wait.' }); return; }

          if (fromCache.length > 0) console.log(`[cache:memory] detail hit for ${fromCache.length}/${listings.length} listings`);

          isBusy = true;
          startSSE(res);
          for (const { url, detail } of fromCache) sse(res, { type: 'detail', url, detail });

          try {
            await deepSearch(toScrape, (event) => {
              if (event.type === 'detail') {
                detailCache.set(event.url, { data: event.detail, cachedAt: Date.now() });
                saveToDisk();
                console.log(`[cache:${DISK_CACHE ? 'disk' : 'memory'}] stored detail for ${event.url}`);
              }
              sse(res, event);
            });
          } catch (err) {
            sse(res, { type: 'error', message: (err as Error).message });
          } finally {
            isBusy = false;
            res.end();
          }
          return;
        }

        next();
      });
    },
  }],
});
