// Server-side only — POST /api/quick-search route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import type { Listing } from '../../lib/recipes/base';
import { getRecipeForUrl } from '../../lib/recipes/server';
import { requireString } from '../../lib/validate';
import { getDb, stmtGetSearch, stmtSetSearch, isFresh, cacheAge } from '../db';
import { readBody, startSSE, sse, sendJSON } from '../helpers';
import { registerSearch, cancelSearch, isSearchCancelled, cleanupSearch } from '../cancellation';

export async function handleQuickSearch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request).catch(() => null);

  let url: string;
  try {
    url = requireString((body as Record<string, unknown>)?.['url'], 'url');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message }); return;
  }

  const searchId = (body as Record<string, unknown>)?.['searchId'];
  const searchIdStr = typeof searchId === 'string' && searchId.trim() ? searchId : undefined;

  const recipe = getRecipeForUrl(url);
  if (!recipe) { sendJSON(response, 400, { error: 'No recipe found for this URL' }); return; }

  const database = getDb();
  const cachedRow = stmtGetSearch(database).get(url);
  if (cachedRow && isFresh(cachedRow.cached_at)) {
    const age = cacheAge(cachedRow.cached_at);
    console.log(`[cache] search hit (${age})`);
    startSSE(response);
    sse(response, { type: 'criteria', filters: recipe.extractImplicitFilters(url) });
    sse(response, { type: 'cached', age });
    for (const listing of JSON.parse(cachedRow.data) as Listing[]) sse(response, { type: 'listing', data: listing });
    sse(response, { type: 'complete' });
    response.end(); return;
  }

  startSSE(response);
  if (searchIdStr) {
    registerSearch(searchIdStr);
    request.on('close', () => cancelSearch(searchIdStr));
  }
  const isCancelled = () => searchIdStr ? isSearchCancelled(searchIdStr) : false;
  const heartbeat = setInterval(() => { try { response.write(': heartbeat\n\n'); } catch { /* ignore */ } }, 15000);
  const listings: Listing[] = [];

  try {
    await recipe.quickSearchAsync(url, (event) => {
      if (event.type === 'listing') listings.push(event.data);
      try { sse(response, event); } catch { /* client disconnected */ }
    }, isCancelled);
    if (!isCancelled() && listings.length > 0) {
      stmtSetSearch(database).run(url, JSON.stringify(listings), Date.now(), listings.length);
      console.log(`[cache] stored ${listings.length} listings`);
    }
  } catch (err) {
    if (!isCancelled()) try { sse(response, { type: 'error', message: (err as Error).message }); } catch { /* ignore */ }
  } finally {
    clearInterval(heartbeat);
    if (searchIdStr) cleanupSearch(searchIdStr);
    try { response.end(); } catch { /* client already disconnected */ }
  }
}
