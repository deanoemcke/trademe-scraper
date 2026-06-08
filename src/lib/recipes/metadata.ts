// Browser-safe — no Node/Playwright imports.
// Single source of truth for which URLs each recipe handles.
// Update this list when adding a new recipe.
export const RECIPE_PATTERNS: Array<{ name: string; hostname: string; pathPrefix?: string }> = [
  { name: 'trademe', hostname: 'trademe.co.nz' },
  { name: 'facebook', hostname: 'facebook.com', pathPrefix: '/marketplace/' },
];
