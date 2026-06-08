import type { RecipeSource } from '../lib/recipes/metadata';
import { esc } from './html';

const SOURCE_META: Record<RecipeSource, { label: string; faviconUrl: string }> = {
  trademe: { label: 'Trade Me', faviconUrl: 'https://www.google.com/s2/favicons?domain=trademe.co.nz&sz=16' },
  facebook: { label: 'Facebook', faviconUrl: 'https://www.google.com/s2/favicons?domain=facebook.com&sz=16' },
};

export function sourceFaviconHtml(source: RecipeSource): string {
  const { label, faviconUrl } = SOURCE_META[source];
  return `<img class="source-favicon" src="${esc(faviconUrl)}" alt="${esc(label)}" title="${esc(label)}" width="14" height="14">`;
}
