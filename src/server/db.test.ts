import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { applySchema, LATEST_VERSION } from './db';

function buildPreMigrationDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE quick_searches (
      url TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    );
    CREATE TABLE deep_details (
      url TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      cached_at INTEGER NOT NULL
    );
    CREATE TABLE saved_searches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      urls TEXT NOT NULL,
      filters TEXT NOT NULL,
      ai_filter TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE trademe_categories (
      slug TEXT PRIMARY KEY,
      display TEXT NOT NULL,
      depth INTEGER NOT NULL,
      parent_slug TEXT,
      top2 TEXT NOT NULL
    );
    ALTER TABLE quick_searches ADD COLUMN listing_count INTEGER;
  `);
  return db;
}

describe('applySchema', () => {
  it('migrates a pre-existing DB that already has listing_count without throwing', () => {
    const db = buildPreMigrationDb();
    expect(() => applySchema(db)).not.toThrow();
  });

  it('leaves the schema at the latest version after migrating', () => {
    const db = buildPreMigrationDb();
    applySchema(db);
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()!;
    expect(row.version).toBe(LATEST_VERSION);
  });

  it('migrates a fresh empty DB to the latest version', () => {
    const db = new Database(':memory:');
    expect(() => applySchema(db)).not.toThrow();
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()!;
    expect(row.version).toBe(LATEST_VERSION);
  });

  it('is idempotent when called on an already-migrated DB', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it('persists the detected version so subsequent starts do not re-detect', () => {
    const db = buildPreMigrationDb();
    applySchema(db);
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()!;
    expect(row.version).toBeGreaterThan(0);
  });
});
