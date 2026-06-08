import { describe, it, expect } from 'vitest';
import { computeFilterReason, type FrontendFilters } from './filters';
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
    url: 'https://www.trademe.co.nz/a/marketplace/listing/12345',
    fulfillment: { pickupAvailable: true, shippingAvailable: true },
    ...overrides,
  };
}

// ── computeFilterReason ───────────────────────────────────────────────────────

describe('computeFilterReason', () => {
  // ── no filter ──────────────────────────────────────────────────────────────

  it('returns null when no filters are set', () => {
    expect(computeFilterReason(makeListing(), defaultFilters)).toBeNull();
  });

  // ── price filter ───────────────────────────────────────────────────────────

  it('returns "price" when listing price is below minPrice', () => {
    expect(computeFilterReason(
      makeListing({ price: 900, priceDisplay: '$900' }),
      { ...defaultFilters, minPrice: 1000 },
    )).toBe('price');
  });

  it('returns null when listing price equals minPrice', () => {
    expect(computeFilterReason(
      makeListing({ price: 1000, priceDisplay: '$1,000' }),
      { ...defaultFilters, minPrice: 1000 },
    )).toBeNull();
  });

  it('returns "price" when listing price exceeds maxPrice', () => {
    expect(computeFilterReason(
      makeListing({ price: 2001, priceDisplay: '$2,001' }),
      { ...defaultFilters, maxPrice: 2000 },
    )).toBe('price');
  });

  it('returns null when listing price equals maxPrice', () => {
    expect(computeFilterReason(
      makeListing({ price: 2000, priceDisplay: '$2,000' }),
      { ...defaultFilters, maxPrice: 2000 },
    )).toBeNull();
  });

  it('returns null when price is null (unlisted price bypasses price filter)', () => {
    expect(computeFilterReason(
      makeListing({ price: null, priceDisplay: 'Make an offer' }),
      { ...defaultFilters, minPrice: 1000, maxPrice: 500 },
    )).toBeNull();
  });

  it('returns "price" when price falls outside both min and max range', () => {
    expect(computeFilterReason(
      makeListing({ price: 500, priceDisplay: '$500' }),
      { ...defaultFilters, minPrice: 1000, maxPrice: 2000 },
    )).toBe('price');
  });

  // ── keyword filter ─────────────────────────────────────────────────────────

  it('returns "keyword" when title does not contain required keyword', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro M1' }),
      { ...defaultFilters, keywords: ['m2'] },
    )).toBe('keyword');
  });

  it('returns null when title contains all required keywords (case-insensitive)', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro M2 14"' }),
      { ...defaultFilters, keywords: ['M2', '14'] },
    )).toBeNull();
  });

  it('returns "keyword" when title contains only some required keywords', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro M2' }),
      { ...defaultFilters, keywords: ['m2', '14'] },
    )).toBe('keyword');
  });

  it('returns "keyword" when title matches an exclude keyword', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro - faulty screen' }),
      { ...defaultFilters, excludeKeywords: ['faulty'] },
    )).toBe('keyword');
  });

  it('returns "keyword" when description matches an exclude keyword', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro', description: 'Cracked screen, for parts only' }),
      { ...defaultFilters, excludeKeywords: ['parts'] },
    )).toBe('keyword');
  });

  it('returns null when neither title nor description matches any exclude keyword', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro M2', description: 'Excellent condition' }),
      { ...defaultFilters, excludeKeywords: ['faulty', 'parts'] },
    )).toBeNull();
  });

  it('returns null when excludeKeywords is empty', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro - faulty' }),
      { ...defaultFilters, excludeKeywords: [] },
    )).toBeNull();
  });

  // ── shipping/pickup filter ─────────────────────────────────────────────────

  it('returns null when listing supports shipping and shipping filter is on', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: { pickupAvailable: false, shippingAvailable: true } }),
      { ...defaultFilters, shippingAvailable: true, pickupAvailable: false },
    )).toBeNull();
  });

  it('returns null when listing supports pickup and pickup filter is on', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: false } }),
      { ...defaultFilters, shippingAvailable: false, pickupAvailable: true },
    )).toBeNull();
  });

  it('returns "shipping" when listing is pickup-only and only shipping filter is on', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: false } }),
      { ...defaultFilters, shippingAvailable: true, pickupAvailable: false },
    )).toBe('shipping');
  });

  it('returns null when both filters are off (treated as no fulfillment filter)', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: true } }),
      { ...defaultFilters, shippingAvailable: false, pickupAvailable: false },
    )).toBeNull();
  });

  it('returns null when both filters are off and listing is pickup-only (no fulfillment filter applied)', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: false } }),
      { ...defaultFilters, shippingAvailable: false, pickupAvailable: false },
    )).toBeNull();
  });

  it('returns null when listing has no fulfillment data regardless of shipping filter', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: undefined }),
      { ...defaultFilters, shippingAvailable: false, pickupAvailable: false },
    )).toBeNull();
  });

  it('returns null when listing supports both and both filters are on', () => {
    expect(computeFilterReason(
      makeListing({ fulfillment: { pickupAvailable: true, shippingAvailable: true } }),
      { ...defaultFilters, shippingAvailable: true, pickupAvailable: true },
    )).toBeNull();
  });

  // ── combined filters ───────────────────────────────────────────────────────

  it('returns "keyword" (first failing filter) when both keyword and price fail', () => {
    // keyword check runs before price — first reason wins
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro M1', price: 500, priceDisplay: '$500' }),
      { ...defaultFilters, keywords: ['m2'], minPrice: 1000 },
    )).toBe('keyword');
  });

  it('returns "price" when keyword passes but price fails', () => {
    expect(computeFilterReason(
      makeListing({ title: 'MacBook Pro M2', price: 500, priceDisplay: '$500' }),
      { ...defaultFilters, keywords: ['m2'], minPrice: 1000 },
    )).toBe('price');
  });

  it('returns "shipping" when keyword and price pass but shipping fails', () => {
    expect(computeFilterReason(
      makeListing({
        title: 'MacBook Pro M2',
        price: 1500,
        priceDisplay: '$1,500',
        fulfillment: { pickupAvailable: true, shippingAvailable: false },
      }),
      { ...defaultFilters, keywords: ['m2'], minPrice: 1000, shippingAvailable: true, pickupAvailable: false },
    )).toBe('shipping');
  });
});
