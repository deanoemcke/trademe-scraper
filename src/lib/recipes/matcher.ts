// Browser-safe — no Node/Playwright imports.
import { RECIPE_PATTERNS } from './metadata';

export function canHandleUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return RECIPE_PATTERNS.some(p => {
      if (!hostname.endsWith(p.hostname)) return false;
      if (!('pathPrefix' in p)) return true;
      return pathname.includes(p.pathPrefix);
    });
  } catch {
    return false;
  }
}
