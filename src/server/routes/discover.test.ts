import { vi, describe, it, expect } from 'vitest';
import { collapseEntries, buildTrademeUrl, buildFacebookUrl } from './discover';
import type { DiscoverEntry } from './discover';

// Mock server-only deps that are not exercised by the pure functions under test.
vi.mock('../db', () => ({}));
vi.mock('../ai', () => ({}));
vi.mock('../helpers', () => ({}));
vi.mock('../../lib/validate', () => ({}));
vi.mock('./regions', () => ({ getRegions: () => [] }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function entry(slug: string, searchString: string | null = null): DiscoverEntry {
  return { slug, searchString };
}

// ── collapseEntries ───────────────────────────────────────────────────────────

describe('collapseEntries', () => {
  it('returns an empty array unchanged', () => {
    expect(collapseEntries([])).toEqual([]);
  });

  it('passes through a single entry with no siblings', () => {
    const input = [entry('computers/laptops/apple')];
    expect(collapseEntries(input)).toEqual(input);
  });

  it('drops a child when its parent is also present in the list', () => {
    // parent present → child must be dropped (Dedup 1)
    const input = [
      entry('computers/laptops'),
      entry('computers/laptops/apple'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('computers/laptops');
  });

  it('collapses two siblings with the same searchString to their parent', () => {
    // Siblings at depth 4 (parentSlug has 3 segments) → collapse
    // e.g. marketplace/computers/laptops/apple & .../dell → marketplace/computers/laptops
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: 'macbook' });
  });

  it('does not collapse siblings when their shared parent slug has fewer than 3 segments', () => {
    // parentSlug = 'computers/laptops' (2 segments) → below the minimum → no collapse
    const input = [
      entry('computers/laptops/apple', 'macbook'),
      entry('computers/laptops/dell', 'macbook'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
  });

  it('does not collapse siblings with different searchStrings', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'latitude'),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
  });

  it('does not collapse a lone entry with no siblings', () => {
    const input = [entry('marketplace/computers/laptops/apple', 'macbook')];
    expect(collapseEntries(input)).toEqual(input);
  });

  it('collapses three siblings to one parent entry', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', null),
      entry('marketplace/computers/laptops/dell', null),
      entry('marketplace/computers/laptops/lenovo', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ slug: 'marketplace/computers/laptops', searchString: null });
  });

  it('collapses one sibling group and leaves unrelated entries untouched', () => {
    const input = [
      entry('marketplace/computers/laptops/apple', 'macbook'),
      entry('marketplace/computers/laptops/dell', 'macbook'),
      entry('marketplace/electronics/cameras/dslr', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(2);
    const slugs = result.map(e => e.slug);
    expect(slugs).toContain('marketplace/computers/laptops');
    expect(slugs).toContain('marketplace/electronics/cameras/dslr');
  });

  it('does not emit the collapsed parent slug twice when three siblings collapse', () => {
    // All three share the same parent — result must contain exactly one collapsed entry
    const input = [
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
      entry('marketplace/furniture/home/dining', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });

  it('does not collapse siblings when their parent is present in the input', () => {
    // parent present means children are dropped by Dedup 1 before sibling collapse runs
    const input = [
      entry('marketplace/furniture/home'),
      entry('marketplace/furniture/home/bedroom', null),
      entry('marketplace/furniture/home/living', null),
    ];
    const result = collapseEntries(input);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('marketplace/furniture/home');
  });
});

// ── buildTrademeUrl ───────────────────────────────────────────────────────────

describe('buildTrademeUrl', () => {
  it('wraps a non-section slug in "marketplace/"', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined);
    expect(url).toContain('/a/marketplace/computers/laptops/search');
  });

  it('does not prefix a section slug with "marketplace/"', () => {
    const url = buildTrademeUrl(entry('motors/cars'), 0, 'any', undefined);
    expect(url).toContain('/a/motors/cars/search');
    expect(url).not.toContain('marketplace');
  });

  it('appends search_string when set', () => {
    const url = buildTrademeUrl(entry('computers/laptops', 'macbook'), 0, 'any', undefined);
    expect(url).toContain('search_string=macbook');
  });

  it('appends price_max when maxPrice > 0', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 500, 'any', undefined);
    expect(url).toContain('price_max=500');
  });

  it('omits price_max when maxPrice is 0', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined);
    expect(url).not.toContain('price_max');
  });

  it('adds pickup params when fulfillment is "pickup" and regionValue is set', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'pickup', '2');
    expect(url).toContain('user_region=2');
    expect(url).toContain('shipping_method=pickup');
  });

  it('does not add pickup params when fulfillment is "pickup" but regionValue is missing', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'pickup', undefined);
    expect(url).not.toContain('shipping_method');
  });

  it('produces a bare search URL when no params apply', () => {
    const url = buildTrademeUrl(entry('computers/laptops'), 0, 'any', undefined);
    expect(url).toBe('https://www.trademe.co.nz/a/marketplace/computers/laptops/search');
  });
});

// ── buildFacebookUrl ──────────────────────────────────────────────────────────

const TEST_REGIONS = [
  { name: 'Auckland', tradeMeRegionId: 2, facebookLocation: 'auckland' },
  { name: 'Wellington', tradeMeRegionId: 12, facebookLocation: 'wellington' },
];

describe('buildFacebookUrl', () => {
  it('always sets query, exact, and sortBy', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', undefined, TEST_REGIONS);
    expect(url).toContain('query=macbook');
    expect(url).toContain('exact=false');
    expect(url).toContain('sortBy=creation_time_descend');
  });

  it('adds maxPrice when > 0', () => {
    const url = buildFacebookUrl('macbook', 800, 'any', undefined, TEST_REGIONS);
    expect(url).toContain('maxPrice=800');
  });

  it('omits maxPrice when 0', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', undefined, TEST_REGIONS);
    expect(url).not.toContain('maxPrice');
  });

  it('sets deliveryMethod=local_pick_up for pickup fulfillment', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', undefined, TEST_REGIONS);
    expect(url).toContain('deliveryMethod=local_pick_up');
  });

  it('sets deliveryMethod=shipping for shipping fulfillment', () => {
    const url = buildFacebookUrl('macbook', 0, 'shipping', undefined, TEST_REGIONS);
    expect(url).toContain('deliveryMethod=shipping');
  });

  it('omits deliveryMethod for "any" fulfillment', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', undefined, TEST_REGIONS);
    expect(url).not.toContain('deliveryMethod');
  });

  it('injects location segment when pickup and regionValue matches a region', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', '2', TEST_REGIONS);
    expect(url).toContain('/marketplace/auckland/search');
  });

  it('omits location segment when pickup but regionValue is undefined', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', undefined, TEST_REGIONS);
    expect(url).toContain('/marketplace/search');
    expect(url).not.toContain('/marketplace/auckland/');
  });

  it('omits location segment when fulfillment is "any" even with regionValue', () => {
    const url = buildFacebookUrl('macbook', 0, 'any', '2', TEST_REGIONS);
    expect(url).not.toContain('/marketplace/auckland/');
  });

  it('omits location segment when regionValue does not match any region', () => {
    const url = buildFacebookUrl('macbook', 0, 'pickup', '999', TEST_REGIONS);
    expect(url).toContain('/marketplace/search');
    expect(url).not.toContain('/marketplace/undefined/');
  });
});
