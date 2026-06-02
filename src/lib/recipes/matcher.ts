// Browser-safe — no Node/Playwright imports.
// Update this list when adding a new recipe.
const SUPPORTED_PATTERNS: Array<{ hostname: string; pathPrefix?: string }> = [
  { hostname: 'trademe.co.nz' },
  { hostname: 'facebook.com', pathPrefix: '/marketplace/' },
];

export function canHandleUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return SUPPORTED_PATTERNS.some(p =>
      hostname.endsWith(p.hostname) && (!p.pathPrefix || pathname.includes(p.pathPrefix))
    );
  } catch {
    return false;
  }
}
