// Server-side only — POST /api/ai-filter route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import { requireArray, requireListingUrl, requireString } from '../../lib/validate';
import { ConcurrencyQueue } from '../../lib/queue';
import { getAIConfig, aiJSON } from '../ai';
import { readBody, startSSE, sse, sendJSON } from '../helpers';

const AI_FILTER_SYSTEM_MESSAGE = 'You are filtering marketplace listings. For each listing decide if it matches the user\'s criteria. Only reject a listing if it explicitly contradicts the criteria — do not reject because information is missing or unstated. If the listing doesn\'t mention something the criteria requires, pass it. Respond ONLY with a JSON object containing a single "results" array, one object per listing in order: {"results":[{"index":1,"pass":true,"reason":null},…]}. "reason" is a short phrase when pass is false, otherwise null.';
const BATCH_SIZE = 50;

export async function handleAiFilter(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readBody(request).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let listings: Array<{ url: string; title: string; price: string; location: string; description: string }>;
  let prompt: string;
  try {
    const rawListings = requireArray(rawBody['listings'], 'listings');
    // Each item is trusted as the expected shape — url presence is the only safety-critical field
    listings = rawListings.map((item, listingIndex) => requireListingUrl(item, listingIndex)) as typeof listings;
    prompt = requireString(rawBody['prompt'], 'prompt');
  } catch (err) {
    sendJSON(response, 400, { error: (err as Error).message }); return;
  }

  const aiConfig = getAIConfig();
  if (typeof aiConfig === 'string') { sendJSON(response, 500, { error: aiConfig }); return; }

  startSSE(response);
  const queue = new ConcurrencyQueue(3);
  let rejectedCount = 0;

  const batches: typeof listings[] = [];
  for (let offset = 0; offset < listings.length; offset += BATCH_SIZE) {
    batches.push(listings.slice(offset, offset + BATCH_SIZE));
  }

  await Promise.all(batches.map(batch => queue.add(async () => {
    const numbered = batch.map((listing, batchIndex) =>
      `${batchIndex + 1}. Title: "${listing.title}" | Price: ${listing.price} | Location: ${listing.location}${listing.description ? ` | Description: ${listing.description}` : ''}`
    ).join('\n');
    try {
      const result = await aiJSON(aiConfig, 'ai-filter', AI_FILTER_SYSTEM_MESSAGE, `Criteria: ${prompt}\n\nListings:\n${numbered}`, 4096);
      if (typeof result !== 'object' || result === null) throw new Error('AI filter: expected object response');
      const parsed: Array<{ index: number; pass: boolean; reason: string | null }> = Array.isArray(result) ? result : (Array.isArray(result.results) ? result.results : []);
      const results = parsed
        .map(resultItem => ({ url: batch[resultItem.index - 1]?.url ?? '', pass: resultItem.pass, reason: resultItem.reason ?? null }))
        .filter(resultItem => resultItem.url);
      rejectedCount += results.filter(resultItem => !resultItem.pass).length;
      sse(response, { type: 'result', results });
    } catch (err) {
      sse(response, { type: 'error', message: (err as Error).message });
    }
  })));

  console.log(`[ai-filter] checked ${listings.length} listings, ${rejectedCount} rejected`);
  response.end();
}
