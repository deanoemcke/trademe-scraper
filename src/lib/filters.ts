import type { Listing } from './scraper';

export interface FrontendFilters {
  minPrice?: number;
  maxPrice?: number;
  keywords?: string[];
  excludeKeywords?: string[];
  shippingAvailable: boolean;
  pickupAvailable: boolean;
}

export function priceToNumber(raw: string): number | null {
  const match = String(raw).replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

export function matchesFilters(listing: Listing, filters: FrontendFilters): boolean {
  const t = listing.title.toLowerCase();

  if (filters.keywords?.length) {
    if (!filters.keywords.every(kw => t.includes(kw.toLowerCase()))) return false;
  }
  if (filters.excludeKeywords?.length) {
    if (filters.excludeKeywords.some(kw => t.includes(kw.toLowerCase()))) return false;
  }

  const price = priceToNumber(listing.price);
  if (price !== null) {
    if (filters.minPrice !== undefined && price < filters.minPrice) return false;
    if (filters.maxPrice !== undefined && price > filters.maxPrice) return false;
  }

  if (listing.allowsPickups !== undefined) {
    const hasShipping = listing.allowsPickups === 1 || listing.allowsPickups === 3;
    const hasPickup   = listing.allowsPickups === 2 || listing.allowsPickups === 3;
    const matches = (filters.shippingAvailable && hasShipping) ||
                    (filters.pickupAvailable   && hasPickup);
    if (!matches) return false;
  }

  return true;
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
