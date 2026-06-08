import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { applySchema, LATEST_VERSION } from './db';

function dbAtVersion(version: number): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (${version});
    CREATE TABLE quick_searches (
      url TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      cached_at INTEGER NOT NULL,
      listing_count INTEGER
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
  `);
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

describe('applySchema', () => {
  it('migrates a fresh empty DB to the latest version', () => {
    const db = new Database(':memory:');
    expect(() => applySchema(db)).not.toThrow();
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()!;
    expect(row.version).toBe(LATEST_VERSION);
  });

  it('does not leave is_complete on quick_searches after a full migration', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(columnNames(db, 'quick_searches')).not.toContain('is_complete');
  });

  it('migrates a DB at version 2 to the latest version', () => {
    const db = dbAtVersion(2);
    expect(() => applySchema(db)).not.toThrow();
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()!;
    expect(row.version).toBe(LATEST_VERSION);
    expect(columnNames(db, 'quick_searches')).not.toContain('is_complete');
  });

  it('is idempotent when called on an already-migrated DB', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get()!;
    expect(row.version).toBe(LATEST_VERSION);
  });
});
