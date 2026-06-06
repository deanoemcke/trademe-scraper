import { defineConfig, loadEnv } from 'vite';

Object.assign(process.env, loadEnv('development', process.cwd(), ''));
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { IncomingMessage, ServerResponse } from 'http';
import { getRecipeForUrl } from './src/lib/recipes/server';
import type { Listing, ListingDetail } from './src/lib/recipes/base';

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;
const DB_PATH = path.resolve(__dirname, '.cache/cache.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS quick_searches (
    url TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deep_details (
    url TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_searches (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    urls       TEXT NOT NULL,
    filters    TEXT NOT NULL,
    ai_filter  TEXT,
    created_at INTEGER NOT NULL
  );
`);

const stmts = {
  getSearch:    db.prepare<[string], { data: string; cached_at: number }>('SELECT data, cached_at FROM quick_searches WHERE url = ?'),
  setSearch:    db.prepare('INSERT OR REPLACE INTO quick_searches (url, data, cached_at) VALUES (?, ?, ?)'),
  clearSearch:  db.prepare('DELETE FROM quick_searches'),
  getDetail:    db.prepare<[string], { data: string; cached_at: number }>('SELECT data, cached_at FROM deep_details WHERE url = ?'),
  setDetail:    db.prepare('INSERT OR REPLACE INTO deep_details (url, data, cached_at) VALUES (?, ?, ?)'),
  clearDetails: db.prepare('DELETE FROM deep_details'),
  countSearch:  db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM quick_searches'),
  countDetails: db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM deep_details'),
  listSavedSearches:  db.prepare<[], { id: string; name: string; urls: string; filters: string; ai_filter: string | null; created_at: number }>('SELECT id, name, urls, filters, ai_filter, created_at FROM saved_searches ORDER BY created_at DESC'),
  getSavedSearch:     db.prepare<[string], { id: string; name: string; urls: string; filters: string; ai_filter: string | null; created_at: number }>('SELECT id, name, urls, filters, ai_filter, created_at FROM saved_searches WHERE id = ?'),
  insertSavedSearch:  db.prepare('INSERT INTO saved_searches (id, name, urls, filters, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  deleteSavedSearch:  db.prepare('DELETE FROM saved_searches WHERE id = ?'),
};

{
  const s = stmts.countSearch.get()!.n;
  const d = stmts.countDetails.get()!.n;
  if (s > 0 || d > 0) console.log(`[cache] opened db — ${s} searches, ${d} listing details`);
}

function isFresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < CACHE_TTL_MS;
}

function cacheAge(cachedAt: number): string {
  const mins = Math.floor((Date.now() - cachedAt) / 60000);
  return mins === 0 ? 'less than a minute ago' : `${mins} minute${mins !== 1 ? 's' : ''} ago`;
}

// ── SSE / body helpers ────────────────────────────────────────────────────────

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

const cancelledSearches = new Set<string>();

// ── Vite config ───────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [{
    name: 'sifty-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = req.url?.split('?')[0] ?? '';

        // ── Saved searches (GET + DELETE) ─────────────────────────────────────
        if (urlPath === '/api/saved-searches' && req.method === 'GET') {
          const rows = stmts.listSavedSearches.all();
          const searches = rows.map(r => ({
            id: r.id, name: r.name,
            urls: JSON.parse(r.urls) as string[],
            filters: JSON.parse(r.filters),
            aiFilter: r.ai_filter,
            createdAt: r.created_at,
          }));
          sendJSON(res, 200, { searches }); return;
        }

        if (urlPath.startsWith('/api/saved-searches/') && req.method === 'GET') {
          const id = urlPath.replace('/api/saved-searches/', '');
          const row = stmts.getSavedSearch.get(id);
          if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
          sendJSON(res, 200, { search: { id: row.id, name: row.name, urls: JSON.parse(row.urls), filters: JSON.parse(row.filters), aiFilter: row.ai_filter, createdAt: row.created_at } }); return;
        }

        if (urlPath.startsWith('/api/saved-searches/') && req.method === 'DELETE') {
          const id = urlPath.replace('/api/saved-searches/', '');
          const row = stmts.getSavedSearch.get(id);
          if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
          stmts.deleteSavedSearch.run(id);
          sendJSON(res, 200, { ok: true }); return;
        }

        if (req.method !== 'POST') { next(); return; }

        // ── Cancel search ─────────────────────────────────────────────────────
        if (req.url === '/api/cancel-search') {
          const body = await readBody(req).catch(() => null);
          const searchId = (body as { searchId?: string })?.searchId;
          if (searchId) cancelledSearches.add(searchId);
          sendJSON(res, 200, { ok: true }); return;
        }

        // ── Quick search ──────────────────────────────────────────────────────
        if (req.url === '/api/quick-search') {
          const body = await readBody(req).catch(() => null);
          const { url, searchId } = (body ?? {}) as { url?: string; searchId?: string };
          if (!url) { sendJSON(res, 400, { error: 'url is required' }); return; }

          const recipe = getRecipeForUrl(url);
          if (!recipe) { sendJSON(res, 400, { error: 'No recipe found for this URL' }); return; }

          const cachedRow = stmts.getSearch.get(url);
          if (cachedRow && isFresh(cachedRow.cached_at)) {
            const age = cacheAge(cachedRow.cached_at);
            console.log(`[cache] search hit (${age})`);
            startSSE(res);
            sse(res, { type: 'criteria', filters: recipe.extractImplicitFilters(url) });
            sse(res, { type: 'cached', age });
            for (const listing of JSON.parse(cachedRow.data) as Listing[]) sse(res, { type: 'listing', data: listing });
            sse(res, { type: 'complete' });
            res.end(); return;
          }

          startSSE(res);
          if (searchId) req.on('close', () => cancelledSearches.add(searchId));
          const isCancelled = () => searchId ? cancelledSearches.has(searchId) : false;
          const listings: Listing[] = [];
          try {
            await recipe.quickSearch(url, (event) => {
              if (event.type === 'listing') listings.push(event.data);
              try { sse(res, event); } catch { /* client disconnected */ }
            }, isCancelled);
            if (!isCancelled() && listings.length > 0) {
              stmts.setSearch.run(url, JSON.stringify(listings), Date.now());
              console.log(`[cache] stored ${listings.length} listings`);
            }
          } catch (err) {
            if (!isCancelled()) try { sse(res, { type: 'error', message: (err as Error).message }); } catch { /* ignore */ }
          } finally {
            if (searchId) cancelledSearches.delete(searchId);
            try { res.end(); } catch { /* client already disconnected */ }
          }
          return;
        }

        // ── Deep search ───────────────────────────────────────────────────────
        if (req.url === '/api/deep-search') {
          const body = await readBody(req).catch(() => null);
          const { listings, deepSearchId } = (body ?? {}) as { listings?: Listing[]; deepSearchId?: string };
          if (!Array.isArray(listings) || listings.length === 0) {
            sendJSON(res, 400, { error: 'listings array is required' }); return;
          }

          const recipe = listings[0]?.url ? getRecipeForUrl(listings[0].url) : null;
          if (!recipe) { sendJSON(res, 400, { error: 'No recipe found for these listings' }); return; }

          const fromCache: { url: string; detail: ListingDetail }[] = [];
          const toScrape: Listing[] = [];
          for (const listing of listings) {
            const row = stmts.getDetail.get(listing.url);
            if (row && isFresh(row.cached_at)) fromCache.push({ url: listing.url, detail: JSON.parse(row.data) as ListingDetail });
            else toScrape.push(listing);
          }

          if (toScrape.length === 0) {
            console.log(`[cache] detail hit for all ${listings.length} listings`);
            startSSE(res);
            for (const { url, detail } of fromCache) sse(res, { type: 'detail', url, detail });
            sse(res, { type: 'complete' });
            res.end(); return;
          }

          if (fromCache.length > 0) console.log(`[cache] detail hit for ${fromCache.length}/${listings.length} listings`);

          startSSE(res);
          if (deepSearchId) req.on('close', () => cancelledSearches.add(deepSearchId));
          const isDeepCancelled = () => deepSearchId ? cancelledSearches.has(deepSearchId) : false;
          for (const { url, detail } of fromCache) sse(res, { type: 'detail', url, detail });

          try {
            await recipe.deepSearch(toScrape, (event) => {
              if (event.type === 'complete' && isDeepCancelled()) return;
              if (event.type === 'detail') {
                stmts.setDetail.run(event.url, JSON.stringify(event.detail), Date.now());
                console.log(`[cache] stored detail for ${event.url}`);
              }
              try { sse(res, event); } catch { /* client disconnected */ }
            }, isDeepCancelled);
          } catch (err) {
            if (!isDeepCancelled()) try { sse(res, { type: 'error', message: (err as Error).message }); } catch { /* ignore */ }
          } finally {
            if (deepSearchId) cancelledSearches.delete(deepSearchId);
            try { res.end(); } catch { /* client already disconnected */ }
          }
          return;
        }

        // ── Cache clear ───────────────────────────────────────────────────────
        if (req.url === '/api/cache/clear') {
          const body = await readBody(req).catch(() => null);
          const type = (body as { type?: string })?.type;
          if (type === 'quick-search') {
            const { n } = stmts.countSearch.get()!;
            stmts.clearSearch.run();
            console.log(`[cache] cleared quick search cache (${n} entries)`);
            sendJSON(res, 200, { ok: true }); return;
          }
          if (type === 'deep-search') {
            const { n } = stmts.countDetails.get()!;
            stmts.clearDetails.run();
            console.log(`[cache] cleared deep search cache (${n} entries)`);
            sendJSON(res, 200, { ok: true }); return;
          }
          sendJSON(res, 400, { error: 'type must be quick-search or deep-search' }); return;
        }

        // ── AI filter ─────────────────────────────────────────────────────────
        if (req.url === '/api/ai-filter') {
          const body = await readBody(req).catch(() => null);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const listings = (body as any)?.listings as Array<{ url: string; title: string; price: string; location: string; description: string }> | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const prompt = (body as any)?.prompt as string | undefined;

          if (!Array.isArray(listings) || listings.length === 0 || !prompt?.trim()) {
            sendJSON(res, 400, { error: 'listings and prompt are required' }); return;
          }

          const apiKey = process.env.GROQ_API_KEY;
          if (!apiKey) {
            sendJSON(res, 500, { error: 'GROQ_API_KEY is not set' }); return;
          }

          const numberedListings = listings.map((l, i) =>
            `${i + 1}. Title: "${l.title}" | Price: ${l.price} | Location: ${l.location}${l.description ? ` | Description: ${l.description}` : ''}`
          ).join('\n');

          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'llama-3.3-70b-versatile',
              max_tokens: 2048,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content: 'You are filtering marketplace listings. For each listing decide if it matches the user\'s criteria. Only reject a listing if it explicitly contradicts the criteria — do not reject because information is missing or unstated. If the listing doesn\'t mention something the criteria requires, pass it. Respond ONLY with a JSON object containing a single "results" array, one object per listing in order: {"results":[{"index":1,"pass":true,"reason":null},…]}. "reason" is a short phrase when pass is false, otherwise null.',
                },
                {
                  role: 'user',
                  content: `Criteria: ${prompt}\n\nListings:\n${numberedListings}`,
                },
              ],
            }),
          });

          if (!groqRes.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const errBody = await groqRes.json().catch(() => ({})) as any;
            sendJSON(res, 500, { error: `Groq API error: ${errBody?.error?.message ?? groqRes.status}` }); return;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const groqData = await groqRes.json() as any;
          const text: string = groqData.choices?.[0]?.message?.content ?? '';

          let parsed: Array<{ index: number; pass: boolean; reason: string | null }>;
          try {
            const wrapper = JSON.parse(text);
            parsed = Array.isArray(wrapper) ? wrapper : (wrapper.results ?? []);
          } catch {
            sendJSON(res, 500, { error: 'Failed to parse AI response' }); return;
          }

          const results = parsed.map(r => ({
            url: listings[r.index - 1]?.url ?? '',
            pass: r.pass,
            reason: r.reason ?? null,
          })).filter(r => r.url);

          console.log(`[ai-filter] checked ${listings.length} listings, ${results.filter(r => !r.pass).length} rejected`);
          sendJSON(res, 200, { results });
          return;
        }

        // ── Save search ───────────────────────────────────────────────────────
        if (req.url === '/api/saved-searches') {
          const body = await readBody(req).catch(() => null);
          const { name, urls, filters, aiFilter } = (body ?? {}) as { name?: unknown; urls?: unknown; filters?: unknown; aiFilter?: unknown };
          if (typeof name !== 'string' || !name.trim()) { sendJSON(res, 400, { error: 'name is required' }); return; }
          if (!Array.isArray(urls) || urls.length === 0) { sendJSON(res, 400, { error: 'urls must be a non-empty array' }); return; }
          if (typeof filters !== 'object' || filters === null) { sendJSON(res, 400, { error: 'filters is required' }); return; }
          try {
            const id = crypto.randomUUID();
            stmts.insertSavedSearch.run(id, name.trim(), JSON.stringify(urls), JSON.stringify(filters), typeof aiFilter === 'string' && aiFilter.trim() ? aiFilter.trim() : null, Date.now());
            sendJSON(res, 200, { ok: true, id });
          } catch (err) {
            sendJSON(res, 500, { error: (err as Error).message });
          }
          return;
        }

        next();
      });
    },
  }],
});
