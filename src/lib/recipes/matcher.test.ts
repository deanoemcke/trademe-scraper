import { describe, it, expect } from 'vitest';
import { isValidRecipeUrl } from './matcher';

describe('isValidRecipeUrl', () => {
  describe('trademe', () => {
    it('accepts a trademe root URL', () => {
      expect(isValidRecipeUrl('https://www.trademe.co.nz/')).toBe(true);
    });

    it('accepts a trademe listing URL with any path', () => {
      expect(isValidRecipeUrl('https://www.trademe.co.nz/a/marketplace/listing/123')).toBe(true);
    });
  });

  describe('facebook marketplace', () => {
    it('accepts a facebook marketplace item URL', () => {
      expect(isValidRecipeUrl('https://www.facebook.com/marketplace/item/123')).toBe(true);
    });

    it('rejects a facebook URL without /marketplace/ path', () => {
      expect(isValidRecipeUrl('https://www.facebook.com/groups/456')).toBe(false);
    });
  });

  describe('unrecognised hostnames', () => {
    it('rejects a URL with wrong hostname even if path matches', () => {
      expect(isValidRecipeUrl('https://www.notfacebook.com/marketplace/item/123')).toBe(false);
    });

    it('rejects a completely unrelated URL', () => {
      expect(isValidRecipeUrl('https://www.google.com/search?q=test')).toBe(false);
    });
  });

  describe('malformed input', () => {
    it('rejects an empty string', () => {
      expect(isValidRecipeUrl('')).toBe(false);
    });

    it('rejects a plain string that is not a URL', () => {
      expect(isValidRecipeUrl('not-a-url')).toBe(false);
    });
  });
});
