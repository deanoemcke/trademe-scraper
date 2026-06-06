# Sifty — Project Bootstrap

## What it is

Sifty is a single-page web app that scrapes marketplace listings and lets you filter them client-side without re-scraping. Primary target is TradeMe (NZ marketplace); secondary is Facebook Marketplace. The current use-case is finding used MacBook Pros, but the scraper architecture is pluggable.

## Goals

- Scrape search results via headless Chromium (Playwright)
- Stream listings to the browser incrementally via SSE
- Filter results instantly in-browser (price, keywords, shipping)
- Optionally enrich listings with full detail pages (deep search)
- Optionally filter via AI (Groq API, llama-3.3-70b-versatile)
- Cache everything in SQLite to avoid redundant scraping

## Tech stack

- **Runtime**: Node.js 18+, TypeScript (ES2022, CommonJS)
- **Build/dev server**: Vite 8 — the API endpoints live as Vite middleware in `vite.config.ts`, not a separate server
- **Scraping**: Playwright (Chromium)
- **Cache**: better-sqlite3, file at `.cache/cache.db`, 1-hour TTL
- **Frontend**: Vanilla HTML/CSS/TS, no framework
- **Tests**: Vitest with JSDOM
- **AI**: Groq API via `GROQ_API_KEY` env var (optional)
- **Facebook**: requires `FB_COOKIES` env var for authenticated access

## Project structure

```
index.html               # SPA entry point (inline CSS, loads app.ts)
vite.config.ts           # ~300 lines — all API endpoints + cache logic
src/
  frontend/
    app.ts               # ~830 lines — all frontend logic
  lib/
    filters.ts           # Client-side filter predicates
    queue.ts             # Per-domain concurrency limiter
    recipes/
      base.ts            # Recipe interface + shared types
      matcher.ts         # URL pattern matching (browser-safe, no Node deps)
      server.ts          # Server-side recipe registry
      trademe.ts         # TradeMe scraper (~458 lines)
      facebook.ts        # Facebook Marketplace scraper (~391 lines)
```

## Architecture

The Vite dev server acts as the backend. `vite.config.ts` registers a plugin that intercepts `/api/*` routes. There is no standalone server process.

**Quick search flow**: User pastes a URL → `POST /api/quick-search` → recipe selected by URL pattern → Playwright fetches results (API interception for TradeMe, DOM/MutationObserver for Facebook) → listings streamed back via SSE → cached in SQLite.

**Deep search flow**: User clicks Deep Search → `POST /api/deep-search` → Playwright opens each listing page → enriched data streamed back → cache checked first per URL.

**Filtering**: Entirely client-side. `matchesFilters()` evaluates each listing; results are shown/hidden via `display: none`. No backend call.

**Cancellation**: Each search gets a UUID (`searchId`). Client posts to `/api/cancel-search`; server adds to a `cancelledSearches` Set; scrapers poll `isCancelled()` and abort in-flight pages.

**SSE event types**: `criteria`, `progress`, `listing`, `detail`, `cached`, `complete`, `error`

## Recipe system

Each recipe implements: `matches(url)`, `extractImplicitFilters(url)`, `quickSearch(...)`, `deepSearch(...)`.

- **TradeMe**: intercepts `api.trademe.co.nz/v1/search` XHR responses; uses GraphQL for buy-now price and delivery options; parses Q&A and reserve status from rendered text.
- **Facebook**: MutationObserver captures listing links; simulates infinite scroll with mouse wheel + keyboard events; detects login wall when partial results are returned. Concurrency: TradeMe=3, Facebook=2.

## Frontend state

No state library. Key module-scoped maps:
- `allListings` — source of truth for all scraped listings
- `listingsByUrl` — fast URL-keyed lookup
- `urlCardStates` — per-search-URL card state (searched, searching, listingUrls, criteria)

Each search URL gets its own card. Results are deduplicated across cards via a `seen` Set. Deep search re-activates if filter changes reveal unsearched listings.

## Running it

```bash
npm run dev      # Dev server on port 3000
npm test         # Run all tests (Vitest)
npm run test:watch
```

Requires `.env` with optional `GROQ_API_KEY` and/or `FB_COOKIES`.

## Git commit style

Conventional commits: `type: description`. Lowercase, imperative mood, no trailing period. Use a semicolon to join multiple changes in one commit. Types used in this project: `fix`, `feat`, `refactor`.

Examples:
```
fix: detect facebook login wall when partial listings are returned
feat: cancel deep search; fix in-flight pages returning results after cancel
refactor: move cancel to status bar link, restore search button behaviour
```

## Notes

Run `git log --oneline -20` at the start of each session to orient on recent work. Commit messages are the source of truth for what changed and why — no separate session log is maintained.
