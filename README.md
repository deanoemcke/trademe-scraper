# trademe-scraper

A Node.js/TypeScript tool that scrapes TradeMe for used MacBook Pro listings. Comes with a web app UI and a CLI. Supports configurable filters and fetches full listing details (description, buy now price, reserve status, pickup info).

## How it works

The scraper uses [Playwright](https://playwright.dev/) to drive a headless Chromium browser. It intercepts TradeMe's internal JSON search API to collect listings efficiently, then visits each filtered listing page to extract the full description and structured metadata from the rendered DOM and GraphQL responses.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
npx playwright install chromium
```

## Web app

```bash
npm start
```

Opens at **http://localhost:3000**.

Paste any TradeMe search URL into the input — the app parses and displays the implicit search criteria (category, search term, condition, RAM, screen size) read-only. Set additional explicit filters below, then:

- **Quick Search** — streams listing cards in as they arrive, showing title, price, and location
- **Deep Search** — runs a quick search first if needed, then fetches full details for each listing (description, buy now price, reserve status, pickup info), enriching the cards one by one as results come in

Results stream in progressively — you don't wait for everything before seeing cards appear.

## CLI

```bash
npm run scrape
```

Runs a hardcoded search and prints full listing details to the terminal. The search URL and filters are configured at the top of [src/scraper.ts](src/scraper.ts).

## Filters

### Web app
Set via the UI inputs: min/max price, keywords (all must match), and exclude keywords (none must match). The exclude keywords field is pre-filled with sensible defaults.

### CLI
Edit the `FILTERS` block near the top of [src/scraper.ts](src/scraper.ts):

```typescript
const FILTERS: FilterCriteria = {
  minPrice: 1000,
  maxPrice: 2500,
  keywords: ['M2'],
  excludeKeywords: ['faulty', 'parts'],
  minYear: 2021,
};
```

To change the base search, update `SEARCH_URL` in the same file.

## Output fields

For each listing that passes the filters:

- Title
- Asking / starting price
- Buy Now price (if set)
- Reserve status (no reserve / met / not met)
- Location
- Pickup details (and whether pickup-only)
- Listing URL
- Full description

## Project structure

```
src/
  lib/scraper.ts   # Core scraper logic — shared by web app and CLI
  server.ts        # Express web server
  scraper.ts       # CLI entry point
public/
  index.html       # Web app frontend
```
