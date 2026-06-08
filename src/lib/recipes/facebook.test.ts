import { describe, it, expect } from 'vitest';
import { parseFacebookPriceLines, buildFacebookListing } from './facebook';

describe('parseFacebookPriceLines', () => {
  it('returns the single price when only one price line is present', () => {
    const result = parseFacebookPriceLines('Vintage lamp\nNZ$80\nAuckland');
    expect(result.priceDisplay).toBe('NZ$80');
    expect(result.price).toBe(80);
  });

  it('discards the original (crossed-out) price when two prices are present, using only the current price', () => {
    // Facebook shows the sale price first and the original price second.
    // Product decision: we surface only the current price; the original is not stored or displayed.
    const result = parseFacebookPriceLines('Nice chair\nNZ$80\nNZ$120\nWellington');
    expect(result.priceDisplay).toBe('NZ$80');
    expect(result.price).toBe(80);
    expect(result.priceDisplay).not.toContain('120');
    expect(result.priceDisplay).not.toContain('<s>');
  });

  it('returns Price on request when no price is present', () => {
    const result = parseFacebookPriceLines('Mystery item\nAuckland');
    expect(result.priceDisplay).toBe('Price on request');
    expect(result.price).toBeNull();
  });

  it('handles Free correctly', () => {
    const result = parseFacebookPriceLines('Free sofa\nFree\nChristchurch');
    expect(result.priceDisplay).toBe('Free');
    expect(result.price).toBeNull();
  });

  it('parses prices with commas', () => {
    const result = parseFacebookPriceLines('Car\nNZ$1,200\nDunedin');
    expect(result.priceDisplay).toBe('NZ$1,200');
    expect(result.price).toBe(1200);
  });

  it('handles empty innerText gracefully', () => {
    const result = parseFacebookPriceLines('');
    expect(result.price).toBeNull();
    expect(result.priceDisplay).toBe('Price on request');
  });

  it('handles whitespace-only innerText gracefully', () => {
    const result = parseFacebookPriceLines('  \n  \n  ');
    expect(result.price).toBeNull();
    expect(result.priceDisplay).toBe('Price on request');
  });

  it('returns normalised lines for caller reuse', () => {
    const result = parseFacebookPriceLines('Vintage lamp\nNZ$80\nAuckland');
    expect(result.lines).toEqual(['Vintage lamp', 'NZ$80', 'Auckland']);
  });
});

describe('buildFacebookListing', () => {
  it('sets source to facebook', () => {
    const listing = buildFacebookListing('https://facebook.com/marketplace/item/123', undefined, 'Vintage lamp', 80, 'NZ$80', 'Auckland');
    expect(listing.source).toBe('facebook');
  });

  it('sets isAuction to false', () => {
    const listing = buildFacebookListing('https://facebook.com/marketplace/item/123', undefined, 'Lamp', null, 'Price on request', 'Wellington');
    expect(listing.isAuction).toBe(false);
  });
});
