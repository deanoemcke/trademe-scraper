// Server-side only — /api/saved-searches route handlers (GET list, GET one, POST, DELETE).

import type { IncomingMessage, ServerResponse } from 'http';
import { getDb, stmtListSavedSearches, stmtGetSavedSearch, stmtInsertSavedSearch, stmtDeleteSavedSearch } from '../db';
import { readBody, sendJSON } from '../helpers';
import { requireString, requireArray } from '../../lib/validate';

export function handleListSavedSearches(_req: unknown, res: ServerResponse): void {
  const db = getDb();
  const rows = stmtListSavedSearches(db).all();
  const searches = rows.map(r => ({
    id: r.id,
    name: r.name,
    urls: JSON.parse(r.urls) as string[],
    filters: JSON.parse(r.filters),
    aiFilter: r.ai_filter,
    createdAt: r.created_at,
  }));
  sendJSON(res, 200, { searches });
}

export function handleGetSavedSearch(_req: unknown, res: ServerResponse, id: string): void {
  const db = getDb();
  const row = stmtGetSavedSearch(db).get(id);
  if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
  sendJSON(res, 200, {
    search: {
      id: row.id,
      name: row.name,
      urls: JSON.parse(row.urls),
      filters: JSON.parse(row.filters),
      aiFilter: row.ai_filter,
      createdAt: row.created_at,
    },
  });
}

export function handleDeleteSavedSearch(_req: unknown, res: ServerResponse, id: string): void {
  const db = getDb();
  const row = stmtGetSavedSearch(db).get(id);
  if (!row) { sendJSON(res, 404, { error: 'Not found' }); return; }
  stmtDeleteSavedSearch(db).run(id);
  sendJSON(res, 200, { ok: true });
}

export async function handleCreateSavedSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req).catch(() => null);
  const rawBody = (body ?? {}) as Record<string, unknown>;

  let name: string;
  let urls: unknown[];
  try {
    name = requireString(rawBody['name'], 'name');
    urls = requireArray(rawBody['urls'], 'urls');
  } catch (err) {
    sendJSON(res, 400, { error: (err as Error).message }); return;
  }

  const filters = rawBody['filters'];
  if (typeof filters !== 'object' || filters === null) { sendJSON(res, 400, { error: 'filters is required' }); return; }

  const aiFilter = rawBody['aiFilter'];
  try {
    const db = getDb();
    const id = crypto.randomUUID();
    stmtInsertSavedSearch(db).run(
      id,
      name.trim(),
      JSON.stringify(urls),
      JSON.stringify(filters),
      typeof aiFilter === 'string' && aiFilter.trim() ? aiFilter.trim() : null,
      Date.now(),
    );
    sendJSON(res, 200, { ok: true, id });
  } catch (err) {
    sendJSON(res, 500, { error: (err as Error).message });
  }
}
