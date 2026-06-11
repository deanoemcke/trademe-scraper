// Server-side only — POST /api/discover route handler.

import type { IncomingMessage, ServerResponse } from "node:http";
import { requirePositiveNumber, requireString } from "../../lib/validate";
import type { AiConfig } from "../ai";
import { aiJSON, getAIConfig } from "../ai";
import { getDb, stmtGetCategoriesAtDepth2, stmtGetCategoriesByTop2 } from "../db";
import { readBody, sendJSON } from "../helpers";
import { getRegions } from "./regions";

const TRADEME_SECTIONS = new Set(["motors", "property", "jobs", "flatmates-wanted", "services"]);

export type DiscoverEntry = { slug: string; searchString: string | null };
type Step2Category = { slug: string; searchString?: string | null };

export const STEP2_SYSTEM_PROMPT =
  "You are a TradeMe NZ shopping assistant. From the categories below pick all subcategories where this item plausibly appears — err on the side of more coverage. Use a deep specific category when the user wants a particular brand/model, or a broader one when they want any item of that type. Never pick both a category and one of its subcategories — always choose the single most appropriate depth. Return JSON: { \"categories\": [{ \"slug\": string, \"searchString\": string | null }] }. Each slug must be a value shown in parentheses. For searchString: rule: use the product name only — no chip names, RAM, year, storage size, or any other specs. If the category already names the item type, use null. Examples: category=bookshelves → null; category=bedroom-furniture/other, item=bookshelf → searchString='bookshelf'; category=apple-laptops, user wants 'Apple MacBook Pro M1 16gb 2021' → searchString='macbook pro'.";

export function buildTrademeUrl(
  entry: DiscoverEntry,
  maxPrice: number,
  fulfillment: string,
  regionValue: string | undefined,
): string {
  const topLevel = entry.slug.split("/")[0];
  const urlSlug = TRADEME_SECTIONS.has(topLevel) ? entry.slug : `marketplace/${entry.slug}`;
  const params = new URLSearchParams();
  if (entry.searchString) params.set("search_string", entry.searchString);
  if (maxPrice > 0) params.set("price_max", String(maxPrice));
  if (fulfillment === "pickup" && regionValue) {
    params.set("user_region", regionValue);
    params.set("shipping_method", "pickup");
  }
  const qs = params.toString();
  return `https://www.trademe.co.nz/a/${urlSlug}/search${qs ? `?${qs}` : ""}`;
}

export function buildFacebookUrl(
  searchTerm: string,
  maxPrice: number,
  fulfillment: string,
  regionValue: string | undefined,
  regions = getRegions(),
): string {
  const pickupOnly = fulfillment === "pickup" && !!regionValue;
  const fbParams = new URLSearchParams();
  fbParams.set("query", searchTerm);
  if (maxPrice > 0) fbParams.set("maxPrice", String(maxPrice));
  if (fulfillment === "pickup") fbParams.set("deliveryMethod", "local_pick_up");
  else if (fulfillment === "shipping") fbParams.set("deliveryMethod", "shipping");
  fbParams.set("exact", "false");
  fbParams.set("sortBy", "creation_time_descend");
  let fbLocationSegment = "";
  if (pickupOnly) {
    const region = regions.find((r) => String(r.tradeMeRegionId) === regionValue);
    if (region?.facebookLocation) fbLocationSegment = `${region.facebookLocation}/`;
  }
  return `https://www.facebook.com/marketplace/${fbLocationSegment}search?${fbParams.toString()}`;
}

export function collapseEntries(allEntries: DiscoverEntry[]): DiscoverEntry[] {
  const allSlugs = new Set(allEntries.map((e) => e.slug));
  const collapsed: DiscoverEntry[] = [];
  const consumed = new Set<string>();

  for (const entry of allEntries) {
    if (consumed.has(entry.slug)) continue;
    const parentSlug = entry.slug.split("/").slice(0, -1).join("/");
    if (allSlugs.has(parentSlug)) continue; // parent present — drop this child (Dedup 1)
    const siblings = allEntries.filter(
      (e) =>
        e !== entry &&
        e.slug.split("/").slice(0, -1).join("/") === parentSlug &&
        e.searchString === entry.searchString,
    );
    if (siblings.length >= 1 && parentSlug && parentSlug.split("/").length >= 3) {
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

type DiscoverResult = {
  urls: string[];
  filters: { maxPrice: number; shippingAvailable: boolean; pickupAvailable: boolean };
  name: string;
};

export async function discoverCategoriesAsync(
  discoveryPrompt: string,
  discoveryMaxPrice: number,
  discoveryFulfillment: string,
  discoveryRegion: string | undefined,
  aiConfig: AiConfig,
  database: ReturnType<typeof getDb>,
): Promise<DiscoverResult> {
  // Step 1: pick broad 2-level categories + extract metadata.
  // Show only display names (not slugs) to avoid confusing the model, then map back.
  const broad = stmtGetCategoriesAtDepth2(database).all();
  const broadDisplayList = broad.map((category) => category.display).join("\n");
  const broadCategoryPick = (await aiJSON(
    aiConfig,
    "step1",
    'You are a TradeMe NZ shopping assistant. From the category list below, pick the 1–3 categories where this item would most likely be listed for sale. Also suggest a short label for the search. Return JSON: { "categories": string[], "name": string } using the exact category names from the list.',
    `I'm looking for: ${discoveryPrompt.trim()}\n\nAvailable categories:\n${broadDisplayList}`,
    4096,
  )) as Record<string, unknown> | null;
  if (typeof broadCategoryPick !== "object" || broadCategoryPick === null)
    throw new Error("discover step1: expected object response");
  const rawCategories = (Array.isArray(broadCategoryPick.categories) ? broadCategoryPick.categories : []) as string[];
  const selectedBroadSlugs: string[] = rawCategories
    .map((display: string) => broad.find((category) => category.display === display)?.slug)
    .filter((slug): slug is string => !!slug);
  console.log(
    `[discover] step1 raw=${JSON.stringify(rawCategories)} → mapped slugs: ${selectedBroadSlugs.join(", ")}`,
  );
  if (selectedBroadSlugs.length === 0) {
    throw new Error("AI returned no valid broad categories");
  }
  if (selectedBroadSlugs.length < rawCategories.length) {
    throw new Error("AI hallucination detected — please try again");
  }

  // Step 2: one parallel call per broad category — pick all plausible subcategories within it.
  const subcategoryPickResults = await Promise.all(
    selectedBroadSlugs.map((top2Slug) => {
      const broadEntry = broad.find((category) => category.slug === top2Slug);
      if (!broadEntry)
        throw new Error(`invariant: slug ${top2Slug} not found in broad categories`);
      const candidates = stmtGetCategoriesByTop2(database).all(top2Slug);
      const specificList = candidates
        .map((category) => `${category.display} (slug: ${category.slug})`)
        .join("\n");
      return aiJSON(
        aiConfig,
        `step2:${top2Slug}`,
        STEP2_SYSTEM_PROMPT,
        `I'm looking for: ${discoveryPrompt.trim()}\n\nCategories within "${broadEntry.display}":\n${specificList}`,
        4096,
      ).then((result) => ({ top2Slug, candidates, result: result as Record<string, unknown> | null }));
    }),
  );

  // Collect all valid entries across step2 results
  const allEntries: DiscoverEntry[] = [];
  for (const { top2Slug, candidates, result } of subcategoryPickResults) {
    const validSlugs = new Set(candidates.map((category) => category.slug));
    if (result === null || !Array.isArray(result.categories)) {
      console.warn(`[discover] step2:${top2Slug} unexpected result: ${JSON.stringify(result)}`);
      continue;
    }
    console.log(`[discover] step2:${top2Slug} raw=${JSON.stringify(result.categories)}`);
    for (const category of (result.categories as Step2Category[]).filter((category) =>
      validSlugs.has(category.slug),
    )) {
      allEntries.push({ slug: category.slug, searchString: category.searchString ?? null });
    }
  }

  const collapsedEntries = collapseEntries(allEntries);
  const pickupOnly = discoveryFulfillment === "pickup" && !!discoveryRegion;
  const urls = collapsedEntries.map((entry) =>
    buildTrademeUrl(entry, discoveryMaxPrice, discoveryFulfillment, discoveryRegion),
  );
  if (urls.length === 0) {
    throw new Error("AI returned no valid specific categories");
  }

  // Append a Facebook Marketplace URL
  const fbSearchTerm = String(broadCategoryPick.name ?? "").trim() || discoveryPrompt.trim();
  urls.push(buildFacebookUrl(fbSearchTerm, discoveryMaxPrice, discoveryFulfillment, discoveryRegion));

  const filters = {
    maxPrice: discoveryMaxPrice,
    shippingAvailable: !pickupOnly,
    pickupAvailable: true,
  };
  const discoveryLabel = String(broadCategoryPick.name ?? "").trim() || discoveryPrompt.trim();
  console.log(
    `[discover] "${discoveryPrompt}" → step1: ${selectedBroadSlugs.join(", ")} → ${urls.length} URL(s) (incl. Facebook), name="${discoveryLabel}"`,
  );
  return { urls, filters, name: discoveryLabel };
}

export async function handleDiscover(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let discoveryPrompt: string;
  let discoveryMaxPrice: number;
  try {
    discoveryPrompt = requireString(rawBody.prompt, "prompt");
    discoveryMaxPrice = requirePositiveNumber(rawBody.maxPrice, "maxPrice");
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message });
    return;
  }
  const discoveryFulfillment = typeof rawBody.fulfillment === "string" ? rawBody.fulfillment : "any";
  const discoveryRegion =
    typeof rawBody.regionValue === "string" && rawBody.regionValue.trim()
      ? rawBody.regionValue
      : undefined;

  const aiConfig = getAIConfig();
  if (typeof aiConfig === "string") {
    sendJSON(response, 500, { error: aiConfig });
    return;
  }

  try {
    const database = getDb();
    const result = await discoverCategoriesAsync(
      discoveryPrompt,
      discoveryMaxPrice,
      discoveryFulfillment,
      discoveryRegion,
      aiConfig,
      database,
    );
    sendJSON(response, 200, result);
  } catch (err) {
    sendJSON(response, 500, { error: (err as Error).message });
  }
}
