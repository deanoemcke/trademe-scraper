import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DB_PATH   = path.resolve(__dirname, '../.cache/cache.db');
const JSON_PATH = path.resolve(__dirname, '../assets/regions.json');

if (!fs.existsSync(JSON_PATH)) {
  console.error(`JSON not found: ${JSON_PATH}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS trademe_regions (
    value   TEXT PRIMARY KEY,
    display TEXT NOT NULL
  );
`);

db.prepare('DELETE FROM trademe_regions').run();
console.log('Cleared trademe_regions.');

interface Region {
  name: string;
  tradeMeRegionId: number;
}

const data: Region[] = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const insert = db.prepare('INSERT INTO trademe_regions (value, display) VALUES (?, ?)');
const insertAll = db.transaction(() => {
  for (const r of data) insert.run(String(r.tradeMeRegionId), r.name);
});
insertAll();

console.log(`Inserted ${data.length} regions:`);
for (const r of data) console.log(`  ${r.tradeMeRegionId}: ${r.name}`);
