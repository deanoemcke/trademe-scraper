// Browser-safe — no Node/Playwright imports.
import { RECIPE_PATTERNS } from './metadata';

export function isValidRecipeUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return RECIPE_PATTERNS.some(p =>
      (hostname === p.hostname || hostname.endsWith('.' + p.hostname)) &&
      pathname.includes(p.pathPrefix)
    );
  } catch {
    return false;
  }
}
