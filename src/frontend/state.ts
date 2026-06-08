// Pure data module — no DOM access, no I/O.
// Owns all mutable frontend state so that app.ts can import rather than declare it,
// and so that tests can call resetState() for clean isolation.

import type { Listing, ListingDetail } from '../lib/recipes/base';
import type { FilterReason } from '../lib/filters';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ListingItem {
  data: Listing;
  detail: ListingDetail | null;
  deepSearched: boolean;
  filterReason: FilterReason | null;
  aiCheckedHash: number | null;
  aiFilterReason: string | null;
}

export interface UrlCardState {
  el: HTMLElement;
  input: HTMLInputElement;
  searchBtn: HTMLButtonElement;
  removeBtn: HTMLButtonElement;
  criteriaEl: HTMLElement;
  countEl: HTMLElement;
  cacheStatusEl: HTMLElement;
  statusEl: HTMLElement;
  searched: boolean;
  searchedUrl: string;
  searching: boolean;
  searchId: string | null;
  cancellationRequested: boolean;
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
}
