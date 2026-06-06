// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { matchesFilters, applyFiltersToDOM, type FrontendFilters } from './filters';
import type { Listing } from './recipes/base';

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultFilters: FrontendFilters = {
  shippingAvailable: true,
  pickupAvailable: true,
};

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    title: 'MacBook Pro 14" M1 Pro',
    price: 1500,
    priceDisplay: '$1,500',
    location: 'Auckland City, Auckland',
    url: `https://www.trademe.co.nz/a/marketplace/listing/${Math.random()}`,
    fulfillment: { pickupAvailable: true, shippingAvailable: true },
    ...overrides,
  };
}

// Renders listing cards into a container + count badge, applies filters,
// then returns { visibleCount, badgeCount } for assertion.
function setupAndApply(listings: Listing[], filters: FrontendFilters) {
  const container = document.createElement('div');
  const countEl = document.createElement('span');

  for (const listing of listings) {
    const card = document.createElement('div');
    card.className = 'listing-card';
    card.setAttribute('data-url', listing.url);
    container.appendChild(card);
  }

  const visibleCount = applyFiltersToDOM(listings, filters, container, countEl);
  const domVisible = container.querySelectorAll<HTMLElement>('.listing-card:not([style*="display: none"])').length;

  return { visibleCount, badgeCount: parseInt(countEl.textContent ?? '0'), domVisible };
}

// ── matchesFilters (unit) ─────────────────────────────────────────────────────

describe('matchesFilters', () => {
  it('passes all listings when no filters set', () => {
    expect(matchesFilters(makeListing(), defaultFilters)).toBe(true);
  });

  it('filters by minPrice', () => {
    expect(matchesFilters(makeListing({ price: 900,   priceDisplay: '$900' }),   { ...defaultFilters, minPrice: 1000 })).toBe(false);
    expect(matchesFilters(makeListing({ price: 1000,  priceDisplay: '$1,000' }), { ...defaultFilters, minPrice: 1000 })).toBe(true);
  });

  it('filters by maxPrice', () => {
    expect(matchesFilters(makeListing({ price: 2001,  priceDisplay: '$2,001' }), { ...defaultFilters, maxPrice: 2000 })).toBe(false);
    expect(matchesFilters(makeListing({ price: 2000,  priceDisplay: '$2,000' }), { ...defaultFilters, maxPrice: 2000 })).toBe(true);
  });

  it('filters by keywords (all must match, case-insensitive)', () => {
    expect(matchesFilters(makeListing({ title: 'MacBook Pro M2' }), { ...defaultFilters, keywords: ['m2'] })).toBe(true);
    expect(matchesFilters(makeListing({ title: 'MacBook Pro M1' }), { ...defaultFilters, keywords: ['m2'] })).toBe(false);
    expect(matchesFilters(makeListing({ title: 'MacBook Pro M2 14"' }), { ...defaultFilters, keywords: ['m2', '14'] })).toBe(true);
    expect(matchesFilters(makeListing({ title: 'MacBook Pro M2' }), { ...defaultFilters, keywords: ['m2', '14'] })).toBe(false);
  });

  it('filters by excludeKeywords', () => {
    expect(matchesFilters(makeListing({ title: 'MacBook Pro - faulty' }), { ...defaultFilters, excludeKeywords: ['faulty'] })).toBe(false);
    expect(matchesFilters(makeListing({ title: 'MacBook Pro - excellent' }), { ...defaultFilters, excludeKeywords: ['faulty'] })).toBe(true);
  });

  it('passes for both shipping and pickup when fulfillment has both', () => {
    const listing = makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: true } });
    expect(matchesFilters(listing, { ...defaultFilters, shippingAvailable: true,  pickupAvailable: false })).toBe(true);
    expect(matchesFilters(listing, { ...defaultFilters, shippingAvailable: false, pickupAvailable: true  })).toBe(true);
    expect(matchesFilters(listing, { ...defaultFilters, shippingAvailable: false, pickupAvailable: false })).toBe(false);
  });

  it('filters by pickup — pickup only fulfillment', () => {
    const listing = makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: false } });
    expect(matchesFilters(listing, { ...defaultFilters, shippingAvailable: false, pickupAvailable: true  })).toBe(true);
    expect(matchesFilters(listing, { ...defaultFilters, shippingAvailable: true,  pickupAvailable: false })).toBe(false);
  });

  it('passes listings with no fulfillment regardless of shipping filter', () => {
    const listing = makeListing({ fulfillment: undefined });
    expect(matchesFilters(listing, { ...defaultFilters, shippingAvailable: false, pickupAvailable: false })).toBe(true);
  });
});

// ── applyFiltersToDOM (high-level) ────────────────────────────────────────────

describe('applyFiltersToDOM', () => {
  it('count badge matches number of visible cards with no filters', () => {
    const listings = [makeListing(), makeListing(), makeListing()];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, defaultFilters);
    expect(visibleCount).toBe(3);
    expect(badgeCount).toBe(3);
    expect(domVisible).toBe(3);
  });

  it('count badge and visible cards match after price filter', () => {
    const listings = [
      makeListing({ price: 500,   priceDisplay: '$500' }),
      makeListing({ price: 1500,  priceDisplay: '$1,500' }),
      makeListing({ price: 2500,  priceDisplay: '$2,500' }),
    ];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, { ...defaultFilters, minPrice: 1000, maxPrice: 2000 });
    expect(visibleCount).toBe(1);
    expect(badgeCount).toBe(1);
    expect(domVisible).toBe(1);
  });

  it('count badge and visible cards match after keyword filter', () => {
    const listings = [
      makeListing({ title: 'MacBook Pro M1' }),
      makeListing({ title: 'MacBook Pro M2' }),
      makeListing({ title: 'MacBook Pro M2 Pro' }),
    ];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, { ...defaultFilters, keywords: ['M2'] });
    expect(visibleCount).toBe(2);
    expect(badgeCount).toBe(2);
    expect(domVisible).toBe(2);
  });

  it('count badge and visible cards match after exclude filter', () => {
    const listings = [
      makeListing({ title: 'MacBook Pro M1' }),
      makeListing({ title: 'MacBook Pro - faulty screen' }),
      makeListing({ title: 'MacBook Pro - for parts' }),
    ];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, { ...defaultFilters, excludeKeywords: ['faulty', 'parts'] });
    expect(visibleCount).toBe(1);
    expect(badgeCount).toBe(1);
    expect(domVisible).toBe(1);
  });

  it('count badge and visible cards match after shipping filter', () => {
    const listings = [
      makeListing({ fulfillment: { pickupAvailable: true,  shippingAvailable: true  } }), // shipping + pickup
      makeListing({ fulfillment: { pickupAvailable: true,  shippingAvailable: false } }), // pickup only
      makeListing({ fulfillment: { pickupAvailable: true,  shippingAvailable: true  } }), // both
    ];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, { ...defaultFilters, shippingAvailable: true, pickupAvailable: false });
    expect(visibleCount).toBe(2); // shipping+pickup listings
    expect(badgeCount).toBe(2);
    expect(domVisible).toBe(2);
  });

  it('shows zero when no listings match', () => {
    const listings = [
      makeListing({ price: 500, priceDisplay: '$500' }),
      makeListing({ price: 600, priceDisplay: '$600' }),
    ];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, { ...defaultFilters, minPrice: 1000 });
    expect(visibleCount).toBe(0);
    expect(badgeCount).toBe(0);
    expect(domVisible).toBe(0);
  });

  it('shows all when filters are cleared (both shipping options checked)', () => {
    const listings = [
      makeListing({ fulfillment: { pickupAvailable: true,  shippingAvailable: true  } }),
      makeListing({ fulfillment: { pickupAvailable: true,  shippingAvailable: false } }),
      makeListing({ fulfillment: { pickupAvailable: true,  shippingAvailable: true  } }),
    ];
    const { visibleCount, badgeCount, domVisible } = setupAndApply(listings, defaultFilters);
    expect(visibleCount).toBe(3);
    expect(badgeCount).toBe(3);
    expect(domVisible).toBe(3);
  });
});
