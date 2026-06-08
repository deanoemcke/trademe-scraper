import { describe, it, expect } from 'vitest';
import { parseFacebookPriceLines } from './facebook';

describe('parseFacebookPriceLines', () => {
  it('returns the single price when only one price line is present', () => {
    const result = parseFacebookPriceLines('Vintage lamp\nNZ$80\nAuckland');
    expect(result.priceDisplay).toBe('NZ$80');
    expect(result.price).toBe(80);
  });

  it('uses only the first price and discards the original when two prices are present', () => {
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
});
