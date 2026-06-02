import { describe, it, expect } from 'vitest';
import {
  applyFilters,
  parseSearchApiResponse,
  extractDescriptionFromText,
  extractStructuredFromText,
  type Listing,
} from './scraper';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    title: 'MacBook Pro 14" 2021 M1 Pro 16GB',
    price: '$1,500',
    location: 'Auckland City, Auckland',
    url: 'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/12345',
    ...overrides,
  };
}

// ── applyFilters ──────────────────────────────────────────────────────────────

describe('applyFilters', () => {
  it('passes everything when filters are empty', () => {
    expect(applyFilters(makeListing(), {})).toBe(true);
  });

  describe('minPrice', () => {
    it('passes when price is above minimum', () => {
      expect(applyFilters(makeListing({ price: '$1,500' }), { minPrice: 1000 })).toBe(true);
    });
    it('passes when price equals minimum', () => {
      expect(applyFilters(makeListing({ price: '$1,000' }), { minPrice: 1000 })).toBe(true);
    });
    it('blocks when price is below minimum', () => {
      expect(applyFilters(makeListing({ price: '$999' }), { minPrice: 1000 })).toBe(false);
    });
  });

  describe('maxPrice', () => {
    it('passes when price is below maximum', () => {
      expect(applyFilters(makeListing({ price: '$1,500' }), { maxPrice: 2000 })).toBe(true);
    });
    it('passes when price equals maximum', () => {
      expect(applyFilters(makeListing({ price: '$2,000' }), { maxPrice: 2000 })).toBe(true);
    });
    it('blocks when price is above maximum', () => {
      expect(applyFilters(makeListing({ price: '$2,001' }), { maxPrice: 2000 })).toBe(false);
    });
  });

  describe('keywords', () => {
    it('passes when all keywords are present (case-insensitive)', () => {
      expect(applyFilters(makeListing({ title: 'MacBook Pro M1 14 inch' }), { keywords: ['m1', '14'] })).toBe(true);
    });
    it('blocks when any keyword is missing', () => {
      expect(applyFilters(makeListing({ title: 'MacBook Pro M1 14 inch' }), { keywords: ['m1', 'm2'] })).toBe(false);
    });
    it('passes with empty keywords array', () => {
      expect(applyFilters(makeListing(), { keywords: [] })).toBe(true);
    });
  });

  describe('excludeKeywords', () => {
    it('passes when no excluded keyword is present', () => {
      expect(applyFilters(makeListing({ title: 'MacBook Pro M1' }), { excludeKeywords: ['faulty', 'parts'] })).toBe(true);
    });
    it('blocks when any excluded keyword is present (case-insensitive)', () => {
      expect(applyFilters(makeListing({ title: 'MacBook Pro - FAULTY screen' }), { excludeKeywords: ['faulty'] })).toBe(false);
    });
    it('passes with empty excludeKeywords array', () => {
      expect(applyFilters(makeListing(), { excludeKeywords: [] })).toBe(true);
    });
  });

  describe('combined filters', () => {
    it('passes when all filters are satisfied', () => {
      expect(applyFilters(
        makeListing({ title: 'MacBook Pro M1 2021', price: '$1,500' }),
        { minPrice: 1000, maxPrice: 2000, keywords: ['M1'], excludeKeywords: ['faulty'] }
      )).toBe(true);
    });
    it('blocks when one filter fails', () => {
      expect(applyFilters(
        makeListing({ title: 'MacBook Pro M1 2021 faulty', price: '$1,500' }),
        { minPrice: 1000, maxPrice: 2000, keywords: ['M1'], excludeKeywords: ['faulty'] }
      )).toBe(false);
    });
  });
});

// ── parseSearchApiResponse ────────────────────────────────────────────────────

describe('parseSearchApiResponse', () => {
  const baseItem = {
    Title: 'MacBook Pro 14"',
    PriceDisplay: '$1,500',
    Region: 'Auckland',
    Suburb: 'Auckland City',
    CanonicalPath: '/marketplace/computers/laptops/laptops/apple/listing/99999',
    PictureHref: 'https://trademe.tmcdn.co.nz/photoserver/thumb/123.jpg',
    AllowsPickups: 3,
  };

  it('maps fields correctly', () => {
    const { listings } = parseSearchApiResponse({ List: [baseItem], TotalCount: 1, PageSize: 56 });
    expect(listings).toHaveLength(1);
    expect(listings[0].title).toBe('MacBook Pro 14"');
    expect(listings[0].price).toBe('$1,500');
    expect(listings[0].location).toBe('Auckland City, Auckland');
    expect(listings[0].url).toBe('https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/99999');
    expect(listings[0].thumbnailUrl).toBe('https://trademe.tmcdn.co.nz/photoserver/thumb/123.jpg');
    expect(listings[0].allowsPickups).toBe(3);
  });

  it('reads TotalCount and PageSize', () => {
    const result = parseSearchApiResponse({ List: [baseItem], TotalCount: 93, PageSize: 22 });
    expect(result.totalCount).toBe(93);
    expect(result.pageSize).toBe(22);
  });

  it('falls back to list length when PageSize is missing', () => {
    const items = [baseItem, { ...baseItem, Title: 'MacBook Air' }];
    const result = parseSearchApiResponse({ List: items, TotalCount: 2 });
    expect(result.pageSize).toBe(2);
  });

  it('filters out items missing title or URL', () => {
    const { listings } = parseSearchApiResponse({
      List: [
        baseItem,
        { ...baseItem, Title: '' },
        { ...baseItem, CanonicalPath: '' },
      ],
      TotalCount: 3,
      PageSize: 56,
    });
    expect(listings).toHaveLength(1);
  });

  it('handles empty list', () => {
    const result = parseSearchApiResponse({ List: [], TotalCount: 0, PageSize: 56 });
    expect(result.listings).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it('handles missing List gracefully', () => {
    const result = parseSearchApiResponse({ TotalCount: 0 });
    expect(result.listings).toHaveLength(0);
  });

  it('joins Suburb and Region with comma', () => {
    const { listings } = parseSearchApiResponse({ List: [baseItem], TotalCount: 1, PageSize: 56 });
    expect(listings[0].location).toBe('Auckland City, Auckland');
  });

  it('falls back to Region alone when Suburb is missing', () => {
    const item = { ...baseItem, Suburb: undefined };
    const { listings } = parseSearchApiResponse({ List: [item], TotalCount: 1, PageSize: 56 });
    expect(listings[0].location).toBe('Auckland');
  });
});

// ── extractDescriptionFromText ────────────────────────────────────────────────

describe('extractDescriptionFromText', () => {
  it('extracts description between marker and shipping section', () => {
    const text = 'Some header\nDescription\nGreat laptop in good condition.\nShipping & pick-up options\nMore content';
    expect(extractDescriptionFromText(text)).toBe('Great laptop in good condition.');
  });

  it('extracts description up to Questions & answers', () => {
    const text = 'Description\nLooks great.\nQuestions & answers\nQ: Is it working?';
    expect(extractDescriptionFromText(text)).toBe('Looks great.');
  });

  it('returns empty string when no description marker is found', () => {
    expect(extractDescriptionFromText('No description here')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    const text = 'Description\n\n  Lots of space around.  \nShipping & pick-up options';
    expect(extractDescriptionFromText(text)).toBe('Lots of space around.');
  });

  it('uses the earliest end marker when multiple are present', () => {
    const text = 'Description\nGood stuff.\nQuestions & answers\nQ&A\nShipping & pick-up options';
    expect(extractDescriptionFromText(text)).toBe('Good stuff.');
  });

  it('returns full text after marker when no end marker is found', () => {
    const text = 'Description\nThis is a long description with no end marker.';
    expect(extractDescriptionFromText(text)).toBe('This is a long description with no end marker.');
  });
});

// ── extractStructuredFromText ─────────────────────────────────────────────────

describe('extractStructuredFromText', () => {
  describe('reserveStatus', () => {
    it('detects no reserve', () => {
      expect(extractStructuredFromText('No reserve\nPlace bid').reserveStatus).toBe('NONE');
    });
    it('detects reserve met', () => {
      expect(extractStructuredFromText('Reserve met\nPlace bid').reserveStatus).toBe('MET');
    });
    it('detects reserve not met', () => {
      expect(extractStructuredFromText('Reserve not met\nPlace bid').reserveStatus).toBe('NOT_MET');
    });
    it('returns UNKNOWN when no reserve info found', () => {
      expect(extractStructuredFromText('Some other text').reserveStatus).toBe('UNKNOWN');
    });
  });

  describe('buyNowPrice', () => {
    it('extracts buy now price', () => {
      expect(extractStructuredFromText('Buy now\n$1,299\nBuy Now').buyNowPrice).toBe(1299);
    });
    it('extracts buy now price without comma', () => {
      expect(extractStructuredFromText('Buy Now\n$999\nBuy Now').buyNowPrice).toBe(999);
    });
    it('returns null when no buy now price', () => {
      expect(extractStructuredFromText('Starting price\n$500').buyNowPrice).toBeNull();
    });
  });

  describe('pickupLocation', () => {
    it('extracts pickup location', () => {
      expect(extractStructuredFromText('Pick up from Auckland City').pickupLocation).toBe('Auckland City');
    });
    it('returns empty string when no pickup location', () => {
      expect(extractStructuredFromText('Shipping available').pickupLocation).toBe('');
    });
  });
});
