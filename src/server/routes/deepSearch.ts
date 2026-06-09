// Server-side only — POST /api/deep-search route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import type { Listing, ListingDetail } from '../../lib/recipes/base';
import { getRecipeForUrl } from '../../lib/recipes/server';
import { requireArray, requireListingUrl } from '../../lib/validate';
import { getDb, stmtGetDetail, stmtSetDetail, isFresh } from '../db';
import { readBody, startSSE, sse, sendJSON } from '../helpers';
import { registerSearch, cancelSearch, isSearchCancelled, cleanupSearch } from '../cancellation';
import { MAX_DEEP_SEARCH_ITEMS } from '../constants';

export async function handleDeepSearch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let validatedListings: Array<{ url: string } & Record<string, unknown>>;
  try {
    const rawListings = requireArray(rawBody['listings'], 'listings');
    validatedListings = rawListings.map((item, listingIndex) => requireListingUrl(item, listingIndex));
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message }); return;
  }

  const deepSearchIdRaw = rawBody['deepSearchId'];
  const deepSearchId = typeof deepSearchIdRaw === 'string' && deepSearchIdRaw.trim() ? deepSearchIdRaw : undefined;

  // Cast to Listing[] — url has been validated; remaining fields are trusted from our own frontend
  // Cap before page allocation to prevent unbounded resource use
  const listings = (validatedListings as unknown as Listing[]).slice(0, MAX_DEEP_SEARCH_ITEMS);

  // Group by recipe so mixed TradeMe+Facebook sets both get scraped
  const listingsByRecipe = new Map<string, Listing[]>();
  for (const listing of listings) {
    const recipe = getRecipeForUrl(listing.url);
    if (!recipe) continue;
    const group = listingsByRecipe.get(recipe.name) ?? [];
    group.push(listing);
    listingsByRecipe.set(recipe.name, group);
  }
  if (listingsByRecipe.size === 0) { sendJSON(response, 400, { error: 'No recipe found for these listings' }); return; }

  const database = getDb();
  const fromCache: { url: string; detail: ListingDetail }[] = [];
  const toScrapeByRecipe = new Map<string, Listing[]>();
  for (const listing of listings) {
    const recipe = getRecipeForUrl(listing.url);
    if (!recipe) continue;
    const row = stmtGetDetail(database).get(listing.url);
    if (row && isFresh(row.cached_at)) fromCache.push({ url: listing.url, detail: JSON.parse(row.data) as ListingDetail });
    else {
      const group = toScrapeByRecipe.get(recipe.name) ?? [];
      group.push(listing);
      toScrapeByRecipe.set(recipe.name, group);
    }
  }

  const totalToScrape = [...toScrapeByRecipe.values()].reduce((total, group) => total + group.length, 0);
  if (totalToScrape === 0) {
    console.log(`[cache] detail hit for all ${listings.length} listings`);
    startSSE(response);
    for (const { url, detail } of fromCache) sse(response, { type: 'detail', url, detail });
    sse(response, { type: 'complete' });
    response.end(); return;
  }

  if (fromCache.length > 0) console.log(`[cache] detail hit for ${fromCache.length}/${listings.length} listings`);

  startSSE(response);
  if (deepSearchId) {
    registerSearch(deepSearchId);
    request.on('close', () => cancelSearch(deepSearchId));
  }
  const isDeepCancelled = () => deepSearchId ? isSearchCancelled(deepSearchId) : false;
  const deepHeartbeat = setInterval(() => { try { response.write(': heartbeat\n\n'); } catch { /* ignore */ } }, 15000);
  for (const { url, detail } of fromCache) sse(response, { type: 'detail', url, detail });

  try {
    await Promise.all(
      [...toScrapeByRecipe.entries()].map(([recipeName, recipeListings]) => {
        const recipe = getRecipeForUrl(recipeListings[0].url)!;
        return recipe.deepSearchAsync(recipeListings, (event) => {
          if (event.type === 'complete') return; // route handler owns termination
          if (event.type === 'detail') {
            stmtSetDetail(database).run(event.url, JSON.stringify(event.detail), Date.now());
            console.log(`[cache][${recipeName}] stored detail for ${event.url}`);
          }
          try { sse(response, event); } catch { /* client disconnected */ }
        }, isDeepCancelled);
      })
    );
    if (!isDeepCancelled()) try { sse(response, { type: 'complete' }); } catch { /* ignore */ }
  } catch (err) {
    if (!isDeepCancelled()) try { sse(response, { type: 'error', message: (err as Error).message }); } catch { /* ignore */ }
  } finally {
    clearInterval(deepHeartbeat);
    if (deepSearchId) cleanupSearch(deepSearchId);
    try { response.end(); } catch { /* client already disconnected */ }
  }
}
