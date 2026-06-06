export interface Listing {
  title: string;
  price: number | null;
  priceDisplay: string;
  location: string;
  url: string;
  thumbnailUrl?: string;
  fulfillment?: { pickupAvailable: boolean; shippingAvailable: boolean };
  description?: string;
  isAuction?: boolean;
}

export interface ListingDetail {
  details: Array<{ key: string; value: string }>;
  description: string;
  buyNowPrice: number | null;
  reserveStatus: string;
  pickupAvailable: boolean | null;
  shippingAvailable: boolean | null;
  pickupLocation: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
}

export type QuickSearchEvent =
  | { type: 'criteria'; filters: Array<[string, string]> }
  | { type: 'progress'; message: string }
  | { type: 'listing'; data: Listing }
  | { type: 'complete' }
  | { type: 'error'; message: string };

export type DeepSearchEvent =
  | { type: 'progress'; index: number; total: number; title: string }
  | { type: 'detail'; url: string; detail: ListingDetail }
  | { type: 'complete' }
  | { type: 'error'; message: string };

export interface Recipe {
  readonly name: string;
  matches(url: string): boolean;
  extractImplicitFilters(url: string): Array<[string, string]>;
  quickSearch(url: string, onEvent: (event: QuickSearchEvent) => void, isCancelled?: () => boolean): Promise<void>;
  deepSearch(listings: Listing[], onEvent: (event: DeepSearchEvent) => void, isCancelled?: () => boolean): Promise<void>;
}
