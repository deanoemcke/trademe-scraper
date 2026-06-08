// ── Scrape depth limits ───────────────────────────────────────────────────────
// Enforced server-side before page allocation to bound resource use regardless
// of how many results a search returns or how many listings a client sends.

/** Maximum number of pages scraped per quick search run (~400–500 listings). */
export const MAX_PAGES_PER_SEARCH = 20;

/** Maximum number of listings processed in a single deep search run. */
export const MAX_DEEP_SEARCH_ITEMS = 100;
