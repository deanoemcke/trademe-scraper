// Server-side only — POST /api/cancel-search route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import { cancelSearch } from '../cancellation';
import { readBody, sendJSON } from '../helpers';

export async function handleCancelSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req).catch(() => null);
  const searchId = (body as Record<string, unknown>)?.['searchId'];
  if (typeof searchId === 'string' && searchId.trim()) cancelSearch(searchId);
  sendJSON(res, 200, { ok: true });
}
