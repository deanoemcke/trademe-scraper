// Server-side only — GET /api/regions route handler.

import fs from 'fs';
import path from 'path';
import type { ServerResponse } from 'http';
import { sendJSON } from '../helpers';

type RegionEntry = { name: string; tradeMeRegionId: number; facebookLocation?: string };

let _regions: RegionEntry[] | null = null;

export function getRegions(): RegionEntry[] {
  if (_regions) return _regions;
  _regions = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../../assets/regions.json'), 'utf8')
  ) as RegionEntry[];
  return _regions;
}

export function handleRegions(_req: unknown, response: ServerResponse): void {
  const regions = getRegions();
  sendJSON(response, 200, regions.map(region => ({ value: String(region.tradeMeRegionId), display: region.name })));
}
