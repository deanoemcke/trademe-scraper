import { describe, it, expect } from 'vitest';
import { sourceFaviconHtml } from './recipeDisplay';

describe('sourceFaviconHtml', () => {
  it('returns an img tag for trademe with correct favicon URL and label', () => {
    const html = sourceFaviconHtml('trademe');
    expect(html).toContain('<img');
    expect(html).toContain('trademe.co.nz');
    expect(html).toContain('Trade Me');
  });

  it('returns an img tag for facebook with correct favicon URL and label', () => {
    const html = sourceFaviconHtml('facebook');
    expect(html).toContain('<img');
    expect(html).toContain('facebook.com');
    expect(html).toContain('Facebook');
  });

  it('includes class, width, height attributes', () => {
    const html = sourceFaviconHtml('trademe');
    expect(html).toContain('class="source-favicon"');
    expect(html).toContain('width="14"');
    expect(html).toContain('height="14"');
  });
});
