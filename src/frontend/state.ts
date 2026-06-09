// Pure data module — no DOM access, no I/O.
// Owns all mutable frontend state so that app.ts can import rather than declare it,
// and so that tests can call resetState() for clean isolation.

import type { Listing, ListingDetail } from '../lib/recipes/base';
import type { FilterReason } from '../lib/filters';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ListingItem {
  data: Listing;
  detail: ListingDetail | null;
  hasBeenDeepSearched: boolean;
  filterReason: FilterReason | null;
  aiCheckedHash: number | null;
  aiFilterReason: string | null;
}

export interface UrlCardState {
  containerElement: HTMLElement;
  input: HTMLInputElement;
  searchButton: HTMLButtonElement;
  removeButton: HTMLButtonElement;
  criteriaElement: HTMLElement;
  countElement: HTMLElement;
  cacheStatusElement: HTMLElement;
  statusElement: HTMLElement;
  hasBeenSearched: boolean;
  searchedUrl: string;
  isSearching: boolean;
  searchId: string | null;
  isCancellationRequested: boolean;
  listingUrls: string[];
}

export interface SavedSearch {
  id: string;
  name: string;
  urls: string[];
  filters: import('../lib/filters').FrontendFilters;
  aiFilter: string | null;
  createdAt: number;
}

// ── State ──────────────────────────────────────────────────────────────────────

export let currentSearchName: string | null = null;
export let showFilteredListings = false;
export let isDeepSearchRunning = false;
export let deepSearchId: string | null = null;
export let deepSearchCancellationRequested = false;
export const listingsByUrl = new Map<string, ListingItem>();
export const urlCardStates: UrlCardState[] = [];
// Stable, collision-free DOM ids assigned at card insertion time via crypto.randomUUID().
// Keyed by listing URL so callers can look up a card without re-deriving its id from the URL.
export const cardIdByUrl = new Map<string, string>();

// ── Setters ────────────────────────────────────────────────────────────────────
// Plain assignment to exported `let` bindings is not visible to importers that
// have already destructured, so we expose explicit setters for the scalar flags.

export function setCurrentSearchName(name: string | null): void {
  currentSearchName = name;
}

export function setShowFilteredListings(value: boolean): void {
  showFilteredListings = value;
}

export function setIsDeepSearchRunning(value: boolean): void {
  isDeepSearchRunning = value;
}

export function setDeepSearchId(id: string | null): void {
  deepSearchId = id;
}

export function setDeepSearchCancellationRequested(value: boolean): void {
  deepSearchCancellationRequested = value;
}

// ── Reset (for tests) ──────────────────────────────────────────────────────────

export function resetState(): void {
  currentSearchName = null;
  showFilteredListings = false;
  isDeepSearchRunning = false;
  deepSearchId = null;
  deepSearchCancellationRequested = false;
  listingsByUrl.clear();
  urlCardStates.length = 0;
  cardIdByUrl.clear();
}
