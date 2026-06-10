// Browser-safe — no Node/Playwright imports.
// Single source of truth for which URLs each recipe handles.
// Update this list when adding a new recipe.
export const RECIPE_PATTERNS = [
  { name: 'trademe', hostname: 'trademe.co.nz', pathPrefix: '' },
  { name: 'facebook', hostname: 'facebook.com', pathPrefix: '/marketplace/' },
] as const;

export type RecipeSource = typeof RECIPE_PATTERNS[number]['name'];
