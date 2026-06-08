// Server-side only — POST /api/cache/clear route handler.

import type { IncomingMessage, ServerResponse } from 'http';
import { getDb, stmtCountSearch, stmtClearSearch, stmtCountDetails, stmtClearDetails } from '../db';
import { readBody, sendJSON } from '../helpers';

export async function handleCacheClear(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req).catch(() => null);
  const type = (body as Record<string, unknown>)?.['type'];

  if (type === 'quick-search') {
    const db = getDb();
    const { n } = stmtCountSearch(db).get()!;
    stmtClearSearch(db).run();
    console.log(`[cache] cleared quick search cache (${n} entries)`);
    sendJSON(res, 200, { ok: true }); return;
  }

  if (type === 'deep-search') {
    const db = getDb();
    const { n } = stmtCountDetails(db).get()!;
    stmtClearDetails(db).run();
    console.log(`[cache] cleared deep search cache (${n} entries)`);
    sendJSON(res, 200, { ok: true }); return;
  }

  sendJSON(res, 400, { error: 'type must be quick-search or deep-search' });
}
