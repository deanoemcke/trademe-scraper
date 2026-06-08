// Server-side only — SQLite database singleton, schema init, and all prepared statements.
// DB is initialised lazily on first call to getDb() — no side effects at module scope.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve(__dirname, '../../.cache/cache.db');

let _db: Database.Database | null = null;

// Each entry is a numbered migration. The version number is the schema version
// that will be recorded after the migration runs. Migrations run in order and
// only when the stored version is below the migration's version number.
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
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
    `,
  },
  {
    version: 2,
    sql: `ALTER TABLE quick_searches ADD COLUMN listing_count INTEGER;`,
  },
  {
    version: 3,
    sql: `ALTER TABLE quick_searches ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    version: 4,
    sql: `ALTER TABLE quick_searches DROP COLUMN is_complete;`,
  },
];

function readSchemaVersion(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
  `);
  const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get();
  if (row === undefined) throw new Error('schema_version table is empty after initialisation');
  return row.version;
}

function writeSchemaVersion(db: Database.Database, version: number): void {
  db.prepare('UPDATE schema_version SET version = ?').run(version);
}

function applySchema(db: Database.Database): void {
  const currentVersion = readSchemaVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > currentVersion);

  if (pending.length === 0) return;

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      writeSchemaVersion(db, migration.version);
    }
  });

  applyAll();
  console.log(`[db] schema migrated from v${currentVersion} to v${pending[pending.length - 1].version}`);
}

function logDbStats(db: Database.Database): void {
  const catCount = (db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM trademe_categories').get()!).n;
  if (catCount === 0) console.warn('[categories] trademe_categories table is empty — run: npx ts-node scripts/import-categories.ts');
  else console.log(`[categories] ${catCount} TradeMe categories loaded`);

  const s = (db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM quick_searches').get()!).n;
  const d = (db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM deep_details').get()!).n;
  if (s > 0 || d > 0) console.log(`[cache] opened db — ${s} searches, ${d} listing details`);
}

export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  applySchema(_db);
  logDbStats(_db);
  return _db;
}

// ── Prepared statement types ──────────────────────────────────────────────────

export type SearchRow  = { data: string; cached_at: number };
export type DetailRow  = { data: string; cached_at: number };
export type SavedSearchRow = {
  id: string;
  name: string;
  urls: string;
  filters: string;
  ai_filter: string | null;
  created_at: number;
};
export type CategoryRow = { slug: string; display: string };
export type CountRow = { n: number };

// ── Statement accessors ───────────────────────────────────────────────────────
// Each function prepares the statement fresh against the live db instance.
// Using per-call prepare() is fine for these low-frequency admin routes;
// for hot-path routes callers should cache the result if needed.

export function stmtGetSearch(db: Database.Database) {
  return db.prepare<[string], SearchRow>('SELECT data, cached_at FROM quick_searches WHERE url = ?');
}
export function stmtSetSearch(db: Database.Database) {
  return db.prepare('INSERT OR REPLACE INTO quick_searches (url, data, cached_at, listing_count) VALUES (?, ?, ?, ?)');
}
export function stmtClearSearch(db: Database.Database) {
  return db.prepare('DELETE FROM quick_searches');
}
export function stmtGetDetail(db: Database.Database) {
  return db.prepare<[string], DetailRow>('SELECT data, cached_at FROM deep_details WHERE url = ?');
}
export function stmtSetDetail(db: Database.Database) {
  return db.prepare('INSERT OR REPLACE INTO deep_details (url, data, cached_at) VALUES (?, ?, ?)');
}
export function stmtClearDetails(db: Database.Database) {
  return db.prepare('DELETE FROM deep_details');
}
export function stmtCountSearch(db: Database.Database) {
  return db.prepare<[], CountRow>('SELECT COUNT(*) as n FROM quick_searches');
}
export function stmtCountDetails(db: Database.Database) {
  return db.prepare<[], CountRow>('SELECT COUNT(*) as n FROM deep_details');
}
export function stmtListSavedSearches(db: Database.Database) {
  return db.prepare<[], SavedSearchRow>('SELECT id, name, urls, filters, ai_filter, created_at FROM saved_searches ORDER BY created_at DESC');
}
export function stmtGetSavedSearch(db: Database.Database) {
  return db.prepare<[string], SavedSearchRow>('SELECT id, name, urls, filters, ai_filter, created_at FROM saved_searches WHERE id = ?');
}
export function stmtInsertSavedSearch(db: Database.Database) {
  return db.prepare('INSERT INTO saved_searches (id, name, urls, filters, ai_filter, created_at) VALUES (?, ?, ?, ?, ?, ?)');
}
export function stmtDeleteSavedSearch(db: Database.Database) {
  return db.prepare('DELETE FROM saved_searches WHERE id = ?');
}
export function stmtGetCategoriesAtDepth2(db: Database.Database) {
  return db.prepare<[], CategoryRow>('SELECT slug, display FROM trademe_categories WHERE depth = 2 ORDER BY slug');
}
export function stmtGetCategoriesByTop2(db: Database.Database) {
  return db.prepare<[string], CategoryRow>('SELECT slug, display FROM trademe_categories WHERE top2 = ? ORDER BY depth, slug');
}

// ── Cache freshness helpers ───────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000;

export function isFresh(cachedAt: number): boolean {
  return Date.now() - cachedAt < CACHE_TTL_MS;
}

export function cacheAge(cachedAt: number): string {
  const mins = Math.floor((Date.now() - cachedAt) / 60000);
  return mins === 0 ? 'less than a minute ago' : `${mins} minute${mins !== 1 ? 's' : ''} ago`;
}
