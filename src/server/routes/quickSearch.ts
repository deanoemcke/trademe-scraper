// Server-side only — POST /api/quick-search route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import type { Listing } from '../../lib/recipes/base';
import { getRecipeForUrl } from '../../lib/recipes/server';
import { requireString } from '../../lib/validate';
import { getDb, stmtGetSearch, stmtSetSearch, isFresh, cacheAge } from '../db';
import { readBody, startSSE, sse, sendJSON } from '../helpers';
import { registerSearch, cancelSearch, isSearchCancelled, cleanupSearch } from '../cancellation';

export async function handleQuickSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req).catch(() => null);

  let url: string;
  try {
    url = requireString((body as Record<string, unknown>)?.['url'], 'url');
  } catch (err) {
    sendJSON(res, 400, { error: (err as Error).message }); return;
  }

  const searchId = (body as Record<string, unknown>)?.['searchId'];
  const searchIdStr = typeof searchId === 'string' && searchId.trim() ? searchId : undefined;

  const recipe = getRecipeForUrl(url);
  if (!recipe) { sendJSON(res, 400, { error: 'No recipe found for this URL' }); return; }

  const db = getDb();
  const cachedRow = stmtGetSearch(db).get(url);
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
  if (searchIdStr) {
    registerSearch(searchIdStr);
    req.on('close', () => cancelSearch(searchIdStr));
  }
  const isCancelled = () => searchIdStr ? isSearchCancelled(searchIdStr) : false;
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* ignore */ } }, 15000);
  const listings: Listing[] = [];

  try {
    await recipe.quickSearch(url, (event) => {
      if (event.type === 'listing') listings.push(event.data);
      try { sse(res, event); } catch { /* client disconnected */ }
    }, isCancelled);
    if (!isCancelled() && listings.length > 0) {
      stmtSetSearch(db).run(url, JSON.stringify(listings), Date.now(), listings.length, 1);
      console.log(`[cache] stored ${listings.length} listings`);
    }
  } catch (err) {
    if (!isCancelled()) try { sse(res, { type: 'error', message: (err as Error).message }); } catch { /* ignore */ }
  } finally {
    clearInterval(heartbeat);
    if (searchIdStr) cleanupSearch(searchIdStr);
    try { res.end(); } catch { /* client already disconnected */ }
  }
}
