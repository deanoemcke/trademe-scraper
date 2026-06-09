// Server-side only — POST /api/discover route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import { requireString, requirePositiveNumber } from '../../lib/validate';
import { getDb, stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2 } from '../db';
import { getAIConfig, aiJSON } from '../ai';
import { readBody, sendJSON } from '../helpers';
import { getRegions } from './regions';

const TRADEME_SECTIONS = new Set(['motors', 'property', 'jobs', 'flatmates-wanted', 'services']);

export type DiscoverEntry = { slug: string; searchString: string | null };
type Step2Category = { slug: string; searchString?: string | null };

export function buildTrademeUrl(entry: DiscoverEntry, maxPrice: number, fulfillment: string, regionValue: string | undefined): string {
  const topLevel = entry.slug.split('/')[0];
  const urlSlug = TRADEME_SECTIONS.has(topLevel) ? entry.slug : `marketplace/${entry.slug}`;
  const params = new URLSearchParams();
  if (entry.searchString) params.set('search_string', entry.searchString);
  if (maxPrice) params.set('price_max', String(maxPrice));
  const pickupOnly = fulfillment === 'pickup' && !!regionValue;
  if (pickupOnly) { params.set('user_region', regionValue!); params.set('shipping_method', 'pickup'); }
  const qs = params.toString();
  return `https://www.trademe.co.nz/a/${urlSlug}/search${qs ? `?${qs}` : ''}`;
}

export function buildFacebookUrl(searchTerm: string, maxPrice: number, fulfillment: string, regionValue: string | undefined, regions = getRegions()): string {
  const pickupOnly = fulfillment === 'pickup' && !!regionValue;
  const fbParams = new URLSearchParams();
  fbParams.set('query', searchTerm);
  if (maxPrice) fbParams.set('maxPrice', String(maxPrice));
  if (fulfillment === 'pickup') fbParams.set('deliveryMethod', 'local_pick_up');
  else if (fulfillment === 'shipping') fbParams.set('deliveryMethod', 'shipping');
  fbParams.set('exact', 'false');
  fbParams.set('sortBy', 'creation_time_descend');
  let fbLocationSegment = '';
  if (pickupOnly && regionValue) {
    const region = regions.find(r => String(r.tradeMeRegionId) === regionValue);
    if (region?.facebookLocation) fbLocationSegment = `${region.facebookLocation}/`;
  }
  return `https://www.facebook.com/marketplace/${fbLocationSegment}search?${fbParams.toString()}`;
}

export function collapseEntries(allEntries: DiscoverEntry[]): DiscoverEntry[] {
  const allSlugs = new Set(allEntries.map(e => e.slug));
  const collapsed: DiscoverEntry[] = [];
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
      for (const sibling of siblings) consumed.add(sibling.slug);
      consumed.add(entry.slug);
      collapsed.push({ slug: parentSlug, searchString: entry.searchString });
    } else {
      collapsed.push(entry);
    }
  }
  return collapsed;
}

export async function handleDiscover(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let discPrompt: string;
  let discMaxPrice: number;
  try {
    discPrompt = requireString(rawBody['prompt'], 'prompt');
    discMaxPrice = requirePositiveNumber(rawBody['maxPrice'], 'maxPrice');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message }); return;
  }
  const discFulfillment = typeof rawBody['fulfillment'] === 'string' ? rawBody['fulfillment'] : 'any';
  const discRegionValue = typeof rawBody['regionValue'] === 'string' && rawBody['regionValue'].trim() ? rawBody['regionValue'] : undefined;

  const aiConfig = getAIConfig();
  if (typeof aiConfig === 'string') { sendJSON(response, 500, { error: aiConfig }); return; }

  try {
    const database = getDb();

    // Step 1: pick broad 2-level categories + extract metadata.
    // Show only display names (not slugs) to avoid confusing the model, then map back.
    const broad = stmtGetCategoriesAtDepth2(database).all();
    const broadDisplayList = broad.map(category => category.display).join('\n');
    const step1 = await aiJSON(
      aiConfig, 'step1',
      'You are a TradeMe NZ shopping assistant. From the category list below, pick the 1–3 categories where this item would most likely be listed for sale. Also suggest a short label for the search. Return JSON: { "categories": string[], "name": string } using the exact category names from the list.',
      `I'm looking for: ${discPrompt.trim()}\n\nAvailable categories:\n${broadDisplayList}`,
      4096
    );
    if (typeof step1 !== 'object' || step1 === null) throw new Error('discover step1: expected object response');
    const rawCategories = (Array.isArray(step1.categories) ? step1.categories : []) as string[];
    const chosenTop2: string[] = rawCategories
      .map((display: string) => broad.find(category => category.display === display)?.slug)
      .filter((slug): slug is string => !!slug);
    console.log(`[discover] step1 raw=${JSON.stringify(rawCategories)} → mapped slugs: ${chosenTop2.join(', ')}`);
    if (chosenTop2.length === 0) { sendJSON(response, 500, { error: 'AI returned no valid broad categories' }); return; }
    if (chosenTop2.length < rawCategories.length) { sendJSON(response, 500, { error: 'AI hallucination detected — please try again' }); return; }

    // Step 2: one parallel call per broad category — pick all plausible subcategories within it.
    const step2Results = await Promise.all(
      chosenTop2.map(top2Slug => {
        const broadEntry = broad.find(category => category.slug === top2Slug)!;
        const candidates = stmtGetCategoriesByTop2(database).all(top2Slug);
        const specificList = candidates.map(category => `${category.display} (slug: ${category.slug})`).join('\n');
        return aiJSON(
          aiConfig, `step2:${top2Slug}`,
          'You are a TradeMe NZ shopping assistant. From the categories below pick all subcategories where this item plausibly appears — err on the side of more coverage. Use a deep specific category when the user wants a particular brand/model, or a broader one when they want any item of that type. Never pick both a category and one of its subcategories — always choose the single most appropriate depth. Return JSON: { "categories": [{ "slug": string, "searchString": string | null }] }. Each slug must be a value shown in parentheses. For searchString: rule: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=bedroom-furniture/other, item=bookshelf → searchString=\'bookshelf\'; category=apple-laptops, user wants \'Apple MacBook Pro M1 16gb 2021\' → searchString=\'macbook pro\'.',
          `I'm looking for: ${discPrompt.trim()}\n\nCategories within "${broadEntry.display}":\n${specificList}`,
          4096
        ).then(result => ({ top2Slug, candidates, result }));
      })
    );

    // Collect all valid entries across step2 results
    const allEntries: DiscoverEntry[] = [];
    for (const { top2Slug, candidates, result } of step2Results) {
      const validSlugs = new Set(candidates.map(category => category.slug));
      if (typeof result !== 'object' || result === null || !Array.isArray(result.categories)) console.warn(`[discover] step2:${top2Slug} unexpected result: ${JSON.stringify(result)}`);
      console.log(`[discover] step2:${top2Slug} raw=${JSON.stringify(result.categories)}`);
      for (const category of ((result.categories ?? []) as Step2Category[]).filter(category => validSlugs.has(category.slug))) {
        allEntries.push({ slug: category.slug, searchString: category.searchString ?? null });
      }
    }

    const collapsedEntries = collapseEntries(allEntries);
    const pickupOnly = discFulfillment === 'pickup' && !!discRegionValue;
    const urls = collapsedEntries.map(entry => buildTrademeUrl(entry, discMaxPrice, discFulfillment, discRegionValue));
    if (urls.length === 0) { sendJSON(response, 500, { error: 'AI returned no valid specific categories' }); return; }

    // Append a Facebook Marketplace URL
    const fbSearchTerm = String(step1.name ?? '').trim() || discPrompt.trim();
    urls.push(buildFacebookUrl(fbSearchTerm, discMaxPrice, discFulfillment, discRegionValue));

    const filters = {
      maxPrice: discMaxPrice,
      minPrice: undefined,
      shippingAvailable: !pickupOnly,
      pickupAvailable: true,
    };
    const discName = String(step1.name ?? '').trim() || discPrompt.trim();
    console.log(`[discover] "${discPrompt}" → step1: ${chosenTop2.join(', ')} → ${urls.length} URL(s) (incl. Facebook), name="${discName}"`);
    sendJSON(response, 200, { urls, filters, name: discName });
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}
