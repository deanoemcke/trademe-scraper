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

  // When both checkboxes are unchecked, treat it as "no fulfillment filter" —
  // unchecking everything means the user does not want to filter by fulfillment.
  const fulfillmentFilterActive = filters.shippingAvailable || filters.pickupAvailable;
  if (fulfillmentFilterActive && listing.fulfillment !== undefined) {
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
