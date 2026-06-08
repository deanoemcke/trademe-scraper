import { vi, describe, it, expect } from 'vitest';
import {
  mapFulfillment,
  parseSearchApiResponse,
  extractDescriptionFromText,
  extractDetails,
  extractQuestionsAndAnswers,
  extractStructuredFromText,
  extractImplicitFilters,
  trademeRecipe,
} from './trademe';
import type { Listing } from './base';

// ── Playwright mock for quickSearch integration tests ─────────────────────────

const { getNextPage, resetPageQueue } = vi.hoisted(() => {
  const queue: unknown[] = [];

  function makePage(data: unknown) {
    const handlers: Array<(r: unknown) => void> = [];
    return {
      on: (_: string, h: (r: unknown) => void) => { handlers.push(h); },
      off: () => {},
      evaluate: async () => null,
      goto: async () => {
        const response = {
          url: () => 'https://api.trademe.co.nz/v1/search/general.json',
          status: () => 200,
          json: async () => data,
        };
        for (const h of [...handlers]) h(response);
      },
      close: async () => {},
    };
  }

  return {
    getNextPage: () => makePage(queue.shift() ?? {}),
    resetPageQueue: (...items: unknown[]) => { queue.splice(0, queue.length, ...items); },
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => ({
      newContext: async () => ({ newPage: async () => getNextPage() }),
      close: async () => {},
    }),
  },
}));

vi.mock('../queue', () => ({
  enqueue: (_: string, fn: () => Promise<unknown>) => fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    title: 'MacBook Pro 14" 2021 M1 Pro 16GB',
    price: 1500,
    priceDisplay: '$1,500',
    location: 'Auckland City, Auckland',
    url: 'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/12345',
    ...overrides,
  };
}

// Keep the listing helper available for future use
makeListing;

// ── mapFulfillment ────────────────────────────────────────────────────────────

describe('mapFulfillment', () => {
  it('value 0 returns undefined (no fulfillment data)', () => {
    expect(mapFulfillment(0)).toBeUndefined();
  });

  it('value 1 returns ships NZ (pickup + shipping available)', () => {
    expect(mapFulfillment(1)).toEqual({ pickupAvailable: true, shippingAvailable: true });
  });

  it('value 2 returns pickup only (no shipping)', () => {
    expect(mapFulfillment(2)).toEqual({ pickupAvailable: true, shippingAvailable: false });
  });

  it('value 3 returns ships NZ paid (pickup + shipping available)', () => {
    expect(mapFulfillment(3)).toEqual({ pickupAvailable: true, shippingAvailable: true });
  });

  it('undefined returns undefined', () => {
    expect(mapFulfillment(undefined)).toBeUndefined();
  });

  it('unknown value warns and returns undefined', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapFulfillment(99)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith('[trademe] unknown allowsPickups value: 99');
    warnSpy.mockRestore();
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
    expect(listings[0].price).toBe(1500);
    expect(listings[0].priceDisplay).toBe('$1,500');
    expect(listings[0].location).toBe('Auckland City, Auckland');
    expect(listings[0].url).toBe('https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/99999');
    expect(listings[0].thumbnailUrl).toBe('https://trademe.tmcdn.co.nz/photoserver/full/123.jpg');
    expect(listings[0].fulfillment).toEqual({ pickupAvailable: true, shippingAvailable: true });
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

// ── extractQuestionsAndAnswers ────────────────────────────────────────────────

describe('extractQuestionsAndAnswers', () => {
  it('returns empty array when section is absent', () => {
    expect(extractQuestionsAndAnswers('Description\nSome text.\nShipping & pick-up options')).toEqual([]);
  });

  it('returns empty array when section has no content', () => {
    expect(extractQuestionsAndAnswers('Questions & answers\nAsk a question\nAbout the seller')).toEqual([]);
  });

  it('parses a single Q&A pair, stripping username and timestamp lines', () => {
    const text = 'Questions & Answers (1)\nWill you ship?\nbuyer (3\n) • Mon\nNo sorry.\nseller (27\n) • Mon\nAsk a question\nAbout the seller';
    expect(extractQuestionsAndAnswers(text)).toEqual([
      { question: 'Will you ship?', answer: 'No sorry.' },
    ]);
  });

  it('parses multiple Q&A pairs', () => {
    const text = [
      'Questions & Answers (2)',
      'Is the iCloud locked?',
      'buyer (27',
      ') • 10:53 am, Fri, 29 May',
      'No, it is not.',
      'seller (27',
      ') • 11:12 am, Fri, 29 May',
      'What is your best price?',
      'buyer2 (5',
      ') • 12:00 pm, Sat, 30 May',
      'Will let the auction run.',
      'seller (27',
      ') • 1:00 pm, Sat, 30 May',
      'Ask a question',
      'About the seller',
    ].join('\n');
    expect(extractQuestionsAndAnswers(text)).toEqual([
      { question: 'Is the iCloud locked?', answer: 'No, it is not.' },
      { question: 'What is your best price?', answer: 'Will let the auction run.' },
    ]);
  });

  it('handles capitalised heading with count and trailing whitespace', () => {
    const text = 'Questions & Answers (5)   \nSome question?\nbuyer (1\n) • Mon\nSome answer.\nseller (2\n) • Tue\nAsk a question\nAbout the seller';
    expect(extractQuestionsAndAnswers(text)).toEqual([
      { question: 'Some question?', answer: 'Some answer.' },
    ]);
  });
});

// ── extractDetails ────────────────────────────────────────────────────────────

describe('extractDetails', () => {
  it('extracts key:value pairs from Details section before Description', () => {
    const text = 'Details\nCondition:\nUsed\nMemory:\n16 to 31 GB\nScreen Size:\n15"\nDescription\nGreat laptop.';
    expect(extractDetails(text)).toEqual([
      { key: 'Condition', value: 'Used' },
      { key: 'Memory', value: '16 to 31 GB' },
      { key: 'Screen Size', value: '15"' },
    ]);
  });

  it('strips trailing colon from keys', () => {
    const text = 'Details\nBrand:\nApple\nDescription\n';
    expect(extractDetails(text)).toEqual([{ key: 'Brand', value: 'Apple' }]);
  });

  it('returns empty array when Details section is absent', () => {
    expect(extractDetails('Description\nGreat item.\nShipping & pick-up options')).toEqual([]);
  });
});

// ── extractDescriptionFromText (real-page patterns) ──────────────────────────

describe('extractDescriptionFromText (real-page patterns)', () => {
  it('strips trailing "Show more" UI text injected by TradeMe', () => {
    const text = 'Description\nGood laptop.\n\nShow more \nShipping & pick-up options';
    expect(extractDescriptionFromText(text)).toBe('Good laptop.');
  });

  it('stops at "Questions & Answers (N)" with capital A and count', () => {
    const text = 'Description\nGreat condition.\nQuestions & Answers (5)\nQ: Working?\nA: Yes.';
    expect(extractDescriptionFromText(text)).toBe('Great condition.');
  });

  it('does not truncate description that starts with "Transmission Details:"', () => {
    const text = 'Description\n\nTransmission Details: 4 Speed Auto\nCondition: Excellent\n\nGreat car.\nShipping & pick-up options\nTo be arranged';
    expect(extractDescriptionFromText(text)).toBe('Transmission Details: 4 Speed Auto\nCondition: Excellent\n\nGreat car.');
  });

  it('stops at Details section header on its own line', () => {
    const text = 'Description\nGreat item.\nDetails\nCondition\nUsed\nShipping & pick-up options';
    expect(extractDescriptionFromText(text)).toBe('Great item.');
  });

  it('extracts description from the MacBook Pro listing with exact innerText', () => {
    const innerText = `Skip to main content\nSearch all of Trade Me\nNotifications\n18\nWatchlist\nMy Trade Me\nD\nmain content\nHome\nMarketplace\nComputers\nLaptops\nLaptops\nApple\nMacBook Pro\nCloses: 22 hours\nWed 3 Jun, 8:15 pm\n Add to Watchlist\n\n29 others watchlisted\n\nCurrent bid\n\n$5.00\n\nPlace bid\n\nReserve met\n\n2 bids so far - view history\n\n Service Fee may apply\nAm I covered by Buyer Protection?\n\nWhen you make a purchase using Ping payments like card or balance, or Afterpay we are able to protect your trade under our Buyer Protection policy, up to $5,000.\n\nLearn more about Trade Me's Buyer Protection.\n\nS\nseaf73 \n(\n27\n)\n100% positive feedback\nSeller located in Auckland City, Auckland\nDetails\nCondition:\nUsed\nMemory:\n16 to 31 GB\nHard Drive Size:\n240 to 499 GB\nScreen Size:\n15"\nCores:\n4\nDescription\n\nThis laptop is working but has a bit of wear and tear... \n\nSpeakers are blown (makes a terrible sound when volume is cranked).\nBattery life isn't great.\nCharger is showing wires (still works but reaching the end of its life).\nLittle corner circle thing is missing for one of the corners so when using the keyboard causes the laptop to move a little bit (please see picture).\nHas stickers and scratches from wear and tear but the screen is in good condition.\n\nOther than that the laptop works. Please don't hesitate to ask any questions. \n\nBuyer must pickup only because I haven't got anything suitable to ship it in.\n\nShow more \nShipping & pick-up options\nDestination & description\tPrice\nPick up from Rodney\tFree\nLearn more about shipping & delivery options.\nPayment Options\n\nPay instantly by card and Ping balance.\n\nWhat's Ping?\n\nOther options\n\nCash\n\nQuestions & Answers (5)\nHey, is the iCloud locked on this device\nkaelynclare (27\n) • 10:53 am, Fri, 29 May\nHi, the iCloud is available, just requires your apple id. Have added a picture of the menu option for you to see. Thanks\nseaf73 (27\n) • 11:12 am, Fri, 29 May\nWhat's your best price you would sell this at?\nkaelynclare (27\n) • 11:58 am, Fri, 29 May\nHi Will just let the auction run thanks\nseaf73 (27\n) • 8:43 pm, Fri, 29 May\nThe year version of this MacBook pro please?\npeterlynn2013 (69\n) • 4:24 pm, Sun, 31 May\nHi, MacBook Pro (Retina, 15 inch, Mid 2015)\nseaf73 (27\n) • 4:42 pm, Sun, 31 May\nwhich part of Rodney to pick up please?\nangelese (26\n) • 8:06 pm, Sun, 31 May\nManly, Whangaparaoa, 0930\nseaf73 (27\n) • 8:46 pm, Sun, 31 May\nWould shipping be an option?\nburritoblue22 (3\n) • 12:15 pm, Mon, 1 Jun\nHi, unfortunately not, I don't have anything suitable to ship it in. Cheers\nseaf73 (27\n) • 1:27 pm, Mon, 1 Jun\nAsk a question\nAbout the seller\nS\nseaf73\n100% positive feedback(27\n)\nLocation\nAuckland City\nMember since\nSunday, 1 May 2022\nView seller's other listings\nLoading...\nRead our safe buying advice\n Share this listing\nPage views: 431\nListing #5956077253\n Community Watch: Report this listing\nWe are upgrading some of our systems\n Learn more\n Tell us what you think\nDesktop site\nHelp\nContact Us\nTerms & conditions\nAbout Us\nNews\nCareers\nAdvertise\nPrivacy policy\nLog out\n© 2026 Trade Me Limited`;
    const desc = extractDescriptionFromText(innerText);
    expect(desc).not.toContain('About the seller');
    expect(desc).toContain('This laptop is working but has a bit of wear and tear');
    expect(desc).toContain('Buyer must pickup only');
  });

  it('extracts Q&A from the MacBook Pro listing with exact innerText', () => {
    const innerText = `Questions & Answers (5)\nHey, is the iCloud locked on this device\nkaelynclare (27\n) • 10:53 am, Fri, 29 May\nHi, the iCloud is available, just requires your apple id. Have added a picture of the menu option for you to see. Thanks\nseaf73 (27\n) • 11:12 am, Fri, 29 May\nWhat's your best price you would sell this at?\nkaelynclare (27\n) • 11:58 am, Fri, 29 May\nHi Will just let the auction run thanks\nseaf73 (27\n) • 8:43 pm, Fri, 29 May\nThe year version of this MacBook pro please?\npeterlynn2013 (69\n) • 4:24 pm, Sun, 31 May\nHi, MacBook Pro (Retina, 15 inch, Mid 2015)\nseaf73 (27\n) • 4:42 pm, Sun, 31 May\nwhich part of Rodney to pick up please?\nangelese (26\n) • 8:06 pm, Sun, 31 May\nManly, Whangaparaoa, 0930\nseaf73 (27\n) • 8:46 pm, Sun, 31 May\nWould shipping be an option?\nburritoblue22 (3\n) • 12:15 pm, Mon, 1 Jun\nHi, unfortunately not, I don't have anything suitable to ship it in. Cheers\nseaf73 (27\n) • 1:27 pm, Mon, 1 Jun\nAsk a question\nAbout the seller`;
    const qa = extractQuestionsAndAnswers(innerText);
    expect(qa.length).toBe(5);
    expect(qa[0].question).toBe('Hey, is the iCloud locked on this device');
    expect(qa[0].answer).toContain('iCloud is available');
  });
});

// ── extractImplicitFilters ────────────────────────────────────────────────────

describe('extractImplicitFilters', () => {
  it('extracts category from path', () => {
    const url = 'https://www.trademe.co.nz/a/marketplace/computers/laptops/search';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Category', 'Marketplace › Computers › Laptops']);
  });

  it('extracts search string', () => {
    const url = 'https://www.trademe.co.nz/a/marketplace/computers/laptops/search?search_string=macbook';
    const filters = extractImplicitFilters(url);
    expect(filters).toContainEqual(['Search', '"macbook"']);
  });

  it('returns empty array for invalid URL', () => {
    expect(extractImplicitFilters('not a url')).toEqual([]);
  });
});

// ── quickSearch multi-page accumulation ───────────────────────────────────────

describe('quickSearch', () => {
  it('emits listings from all pages when results span multiple pages', async () => {
    const makeItem = (i: number) => ({
      Title: `Item ${i}`,
      PriceDisplay: '$1',
      Region: 'Auckland',
      CanonicalPath: `/listing/${i}`,
    });

    resetPageQueue(
      { List: Array.from({ length: 22 }, (_, i) => makeItem(i + 1)), TotalCount: 27, PageSize: 22 },
      { List: Array.from({ length: 5 },  (_, i) => makeItem(i + 23)), TotalCount: 27, PageSize: 22 },
    );

    const collected: unknown[] = [];
    await trademeRecipe.quickSearch(
      'https://www.trademe.co.nz/a/marketplace/computers/search',
      (ev) => { if (ev.type === 'listing') collected.push(ev.data); },
    );

    expect(collected).toHaveLength(27);
  });
});
