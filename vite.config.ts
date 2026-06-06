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
  CREATE TABLE IF NOT EXISTS trademe_categories (
    slug        TEXT PRIMARY KEY,
    display     TEXT NOT NULL,
    depth       INTEGER NOT NULL,
    parent_slug TEXT,
    top2        TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trademe_regions (
    value   TEXT PRIMARY KEY,
    display TEXT NOT NULL
  );
`);

{
  const catCount = (db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM trademe_categories').get()!).n;
  if (catCount === 0) console.warn('[categories] trademe_categories table is empty — run: npx ts-node scripts/import-categories.ts');
  else console.log(`[categories] ${catCount} TradeMe categories loaded`);

  const regionCount = (db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM trademe_regions').get()!).n;
  if (regionCount === 0) console.warn('[regions] trademe_regions table is empty — run: npx ts-node scripts/import-regions.ts');
  else console.log(`[regions] ${regionCount} TradeMe regions loaded`);
}

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
  getCategoriesAtDepth2: db.prepare<[], { slug: string; display: string }>('SELECT slug, display FROM trademe_categories WHERE depth = 2 ORDER BY slug'),
  getCategoriesByTop2:   db.prepare<[string], { slug: string; display: string }>('SELECT slug, display FROM trademe_categories WHERE top2 = ? ORDER BY depth, slug'),
  getRegions:            db.prepare<[], { value: string; display: string }>('SELECT value, display FROM trademe_regions ORDER BY display'),
  getRegionById:         db.prepare<[string], { display: string }>('SELECT display FROM trademe_regions WHERE value = ?'),
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

// ── AI provider ──────────────────────────────────────────────────────────────

const AI_PROVIDERS: Record<string, { url: string; model: string; keyVar: string }> = {
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',                          model: 'llama-3.3-70b-versatile',           keyVar: 'GROQ_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',                            model: 'meta-llama/llama-3.3-70b-instruct', keyVar: 'OPENROUTER_API_KEY' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.1-flash-lite',              keyVar: 'GEMINI_API_KEY' },
};

function getAIConfig(): { url: string; model: string; apiKey: string } | string {
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return `Unknown AI_PROVIDER "${provider}" — use groq, openrouter, or gemini`;
  const apiKey = process.env[cfg.keyVar];
  if (!apiKey) return `${cfg.keyVar} is not set`;
  return { url: cfg.url, model: cfg.model, apiKey };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function aiJSON(cfg: { url: string; model: string; apiKey: string }, label: string, systemMsg: string, userMsg: string, maxTokens: number): Promise<any> {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
    }),
  });
  if (!r.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = await r.json().catch(() => ({})) as any;
    const body = Array.isArray(e) ? e[0] : e;
    const msg = body?.error?.message ?? body?.message ?? JSON.stringify(e);
    throw new Error(`AI error (${label}) [${r.status}]: ${msg || r.statusText}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await r.json() as any;
  const raw: string = d.choices?.[0]?.message?.content ?? '{}';
  // Extract JSON from a markdown code fence if the model wrapped it in prose
  let stripped: string;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    stripped = fenceMatch[1].trim();
  } else {
    // Fallback: grab from first { to last }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    stripped = jsonMatch ? jsonMatch[0].trim() : raw.trim();
  }
  try {
    return JSON.parse(stripped);
  } catch {
    throw new Error(`AI parse error (${label}): ${stripped.slice(0, 200)}`);
  }
}

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

        if (req.url === '/api/regions' && req.method === 'GET') {
          sendJSON(res, 200, stmts.getRegions.all()); return;
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

          const aiCfg = getAIConfig();
          if (typeof aiCfg === 'string') { sendJSON(res, 500, { error: aiCfg }); return; }

          const numberedListings = listings.map((l, i) =>
            `${i + 1}. Title: "${l.title}" | Price: ${l.price} | Location: ${l.location}${l.description ? ` | Description: ${l.description}` : ''}`
          ).join('\n');

          let parsed: Array<{ index: number; pass: boolean; reason: string | null }>;
          try {
            const result = await aiJSON(
              aiCfg, 'ai-filter',
              'You are filtering marketplace listings. For each listing decide if it matches the user\'s criteria. Only reject a listing if it explicitly contradicts the criteria — do not reject because information is missing or unstated. If the listing doesn\'t mention something the criteria requires, pass it. Respond ONLY with a JSON object containing a single "results" array, one object per listing in order: {"results":[{"index":1,"pass":true,"reason":null},…]}. "reason" is a short phrase when pass is false, otherwise null.',
              `Criteria: ${prompt}\n\nListings:\n${numberedListings}`,
              4096
            );
            parsed = Array.isArray(result) ? result : (result.results ?? []);
          } catch (err) {
            sendJSON(res, 500, { error: (err as Error).message }); return;
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

        // ── Discover ─────────────────────────────────────────────────────────
        if (req.url === '/api/discover') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const body = await readBody(req).catch(() => null);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const discPrompt = (body as any)?.prompt as string | undefined;
          const discMaxPrice = (body as any)?.maxPrice as number | undefined;
          const discFulfillment = ((body as any)?.fulfillment as string | undefined) ?? 'any';
          const discRegionValue = (body as any)?.regionValue as string | undefined;
          if (!discPrompt?.trim()) { sendJSON(res, 400, { error: 'prompt is required' }); return; }
          if (!discMaxPrice || discMaxPrice <= 0) { sendJSON(res, 400, { error: 'maxPrice is required' }); return; }

          const aiCfg = getAIConfig();
          if (typeof aiCfg === 'string') { sendJSON(res, 500, { error: aiCfg }); return; }

          try {
            // Step 1: pick broad 2-level categories + extract metadata.
            // Show only display names (not slugs) to avoid confusing the model, then map back.
            const broad = stmts.getCategoriesAtDepth2.all();
            const broadDisplayList = broad.map(c => c.display).join('\n');
            const step1 = await aiJSON(
              aiCfg, 'step1',
              'You are a TradeMe NZ shopping assistant. From the category list below, pick the 1–3 categories where this item would most likely be listed for sale. Also suggest a short label for the search. Return JSON: { "categories": string[], "name": string } using the exact category names from the list.',
              `I'm looking for: ${discPrompt.trim()}\n\nAvailable categories:\n${broadDisplayList}`,
              4096
            );
            const rawCategories = (step1.categories ?? []) as string[];
            const chosenTop2: string[] = rawCategories
              .map((display: string) => broad.find(c => c.display === display)?.slug)
              .filter((s): s is string => !!s);
            console.log(`[discover] step1 raw=${JSON.stringify(rawCategories)} → mapped slugs: ${chosenTop2.join(', ')}`);
            if (chosenTop2.length === 0) { sendJSON(res, 500, { error: 'AI returned no valid broad categories' }); return; }
            if (chosenTop2.length < rawCategories.length) { sendJSON(res, 500, { error: 'AI hallucination detected — please try again' }); return; }

            // Step 2: one parallel call per broad category — pick all plausible subcategories within it.
            type Step2Category = { slug: string; searchString?: string | null };
            const step2Results = await Promise.all(
              chosenTop2.map(t2 => {
                const broadEntry = broad.find(c => c.slug === t2)!;
                const candidates = stmts.getCategoriesByTop2.all(t2);
                const specificList = candidates.map(c => `${c.display} (slug: ${c.slug})`).join('\n');
                return aiJSON(
                  aiCfg, `step2:${t2}`,
                  'You are a TradeMe NZ shopping assistant. From the categories below pick all subcategories where this item plausibly appears — err on the side of more coverage. Use a deep specific category when the user wants a particular brand/model, or a broader one when they want any item of that type. Never pick both a category and one of its subcategories — always choose the single most appropriate depth. Return JSON: { "categories": [{ "slug": string, "searchString": string | null }] }. Each slug must be a value shown in parentheses. For searchString: rule: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=bedroom-furniture/other, item=bookshelf → searchString=\'bookshelf\'; category=apple-laptops, user wants \'Apple MacBook Pro M1 16gb 2021\' → searchString=\'macbook pro\'.',
                  `I'm looking for: ${discPrompt.trim()}\n\nCategories within "${broadEntry.display}":\n${specificList}`,
                  4096
                ).then(result => ({ t2, candidates, result }));
              })
            );

            // Collect all valid entries across step2 results, then drop any slug whose parent is also
            // present (parent is a superset — child would be redundant scraping)
            const allEntries: { slug: string; searchString: string | null }[] = [];
            for (const { t2, candidates, result } of step2Results) {
              const validSlugs = new Set(candidates.map(c => c.slug));
              if (!result.categories) console.warn(`[discover] step2:${t2} unexpected result: ${JSON.stringify(result)}`);
              console.log(`[discover] step2:${t2} raw=${JSON.stringify(result.categories)}`);
              for (const c of ((result.categories ?? []) as Step2Category[]).filter(c => validSlugs.has(c.slug))) {
                allEntries.push({ slug: c.slug, searchString: c.searchString ?? null });
              }
            }
            // Dedup 1: if a parent slug is already in the set, drop its children (parent is a superset).
            // Dedup 2: if 2+ siblings share the same parent (not in set) and the same searchString,
            // collapse them into the parent — avoids redundant era/subcategory splits like
            // furniture/pre-1900 + furniture/19001949 + furniture/1950today all becoming furniture.
            // If siblings have different searchStrings they're genuinely distinct; leave them alone.
            const allSlugs = new Set(allEntries.map(e => e.slug));
            const collapsed: typeof allEntries = [];
            const consumed = new Set<string>();
            for (const entry of allEntries) {
              if (consumed.has(entry.slug)) continue;
              const parentSlug = entry.slug.split('/').slice(0, -1).join('/');
              if (allSlugs.has(parentSlug)) continue; // parent present — drop this child (Dedup 1)
              const siblings = allEntries.filter(e =>
                e !== entry &&
                e.slug.split('/').slice(0, -1).join('/') === parentSlug &&
                e.searchString === entry.searchString
              );
              if (siblings.length >= 1 && parentSlug && parentSlug.split('/').length >= 3) {
                // 2+ siblings with same searchString — collapse to parent
                for (const s of siblings) consumed.add(s.slug);
                consumed.add(entry.slug);
                collapsed.push({ slug: parentSlug, searchString: entry.searchString });
              } else {
                collapsed.push(entry);
              }
            }
            // Motors, property, jobs etc. have their own URL sections; everything else is under /marketplace/
            const TRADEME_SECTIONS = new Set(['motors', 'property', 'jobs', 'flatmates-wanted', 'services']);
            const pickupOnly = discFulfillment === 'pickup' && !!discRegionValue;
            const urls = collapsed.map(e => {
              const topLevel = e.slug.split('/')[0];
              const urlSlug = TRADEME_SECTIONS.has(topLevel) ? e.slug : `marketplace/${e.slug}`;
              const params = new URLSearchParams();
              if (e.searchString) params.set('search_string', e.searchString);
              if (discMaxPrice) params.set('price_max', String(discMaxPrice));
              if (pickupOnly) { params.set('user_region', discRegionValue!); params.set('shipping_method', 'pickup'); }
              const qs = params.toString();
              return `https://www.trademe.co.nz/a/${urlSlug}/search${qs ? `?${qs}` : ''}`;
            });
            if (urls.length === 0) { sendJSON(res, 500, { error: 'AI returned no valid specific categories' }); return; }

            const filters = {
              maxPrice: discMaxPrice,
              minPrice: undefined,
              shippingAvailable: !pickupOnly,
              pickupAvailable: true,
            };
            console.log(`[discover] "${discPrompt}" → step1: ${chosenTop2.join(', ')} → ${urls.length} URL(s), name="${step1.name}"`);
            sendJSON(res, 200, { urls, filters, name: step1.name ?? discPrompt.trim() });
          } catch (err) {
            sendJSON(res, 500, { error: (err as Error).message });
          }
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
