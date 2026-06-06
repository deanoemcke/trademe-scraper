import type { Listing } from './recipes/base';

export interface FrontendFilters {
  minPrice?: number;
  maxPrice?: number;
  keywords?: string[];
  excludeKeywords?: string[];
  shippingAvailable: boolean;
  pickupAvailable: boolean;
}

export type FilterReason = 'keyword' | 'price' | 'shipping';

export function computeFilterReason(listing: Listing, filters: FrontendFilters): FilterReason | null {
  const t = listing.title.toLowerCase();

  if (filters.keywords?.length) {
    if (!filters.keywords.every(kw => t.includes(kw.toLowerCase()))) return 'keyword';
  }
  if (filters.excludeKeywords?.length) {
    const d = listing.description?.toLowerCase() ?? '';
    if (filters.excludeKeywords.some(kw => t.includes(kw.toLowerCase()) || d.includes(kw.toLowerCase()))) return 'keyword';
  }

  if (listing.price !== null) {
    if (filters.minPrice !== undefined && listing.price < filters.minPrice) return 'price';
    if (filters.maxPrice !== undefined && listing.price > filters.maxPrice) return 'price';
  }

  if (listing.fulfillment !== undefined) {
    const { pickupAvailable, shippingAvailable } = listing.fulfillment;
    const matches = (filters.shippingAvailable && shippingAvailable) ||
                    (filters.pickupAvailable   && pickupAvailable);
    if (!matches) return 'shipping';
  }

  return null;
}

export function matchesFilters(listing: Listing, filters: FrontendFilters): boolean {
  return computeFilterReason(listing, filters) === null;
}

// Applies filters to a set of rendered listing cards in the DOM.
// Each card must have data-url set. Returns the visible count.
export function applyFiltersToDOM(
  listings: Listing[],
  filters: FrontendFilters,
  container: HTMLElement,
  countEl: HTMLElement
): number {
  let visible = 0;
  for (const listing of listings) {
    const show = matchesFilters(listing, filters);
    const card = container.querySelector<HTMLElement>(`[data-url="${listing.url}"]`);
    if (card) card.style.display = show ? '' : 'none';
    if (show) visible++;
  }
  countEl.textContent = String(visible);
  return visible;
}
