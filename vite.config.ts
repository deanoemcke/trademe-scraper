import { defineConfig, loadEnv } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';
import { handleCancelSearch } from './src/server/routes/cancelSearch';
import { handleQuickSearch } from './src/server/routes/quickSearch';
import { handleDeepSearch } from './src/server/routes/deepSearch';
import { handleAiFilter } from './src/server/routes/aiFilter';
import { handleDiscover } from './src/server/routes/discover';
import { handleListSavedSearches, handleGetSavedSearch, handleDeleteSavedSearch, handleCreateSavedSearch } from './src/server/routes/savedSearches';
import { handleRegions } from './src/server/routes/regions';
import { handleCacheClear } from './src/server/routes/cacheRoutes';

Object.assign(process.env, loadEnv('development', process.cwd(), ''));

type Next = (err?: unknown) => void;

export default defineConfig({
  plugins: [{
    name: 'sifty-api',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: Next) => {
        const urlPath = req.url?.split('?')[0] ?? '';

        // ── GET routes ────────────────────────────────────────────────────────

        if (urlPath === '/api/saved-searches' && req.method === 'GET') {
          handleListSavedSearches(req, res); return;
        }
        if (urlPath.startsWith('/api/saved-searches/') && req.method === 'GET') {
          const id = urlPath.slice('/api/saved-searches/'.length);
          handleGetSavedSearch(req, res, id); return;
        }
        if (urlPath.startsWith('/api/saved-searches/') && req.method === 'DELETE') {
          const id = urlPath.slice('/api/saved-searches/'.length);
          handleDeleteSavedSearch(req, res, id); return;
        }
        if (urlPath === '/api/regions' && req.method === 'GET') {
          handleRegions(req, res); return;
        }

        if (req.method !== 'POST') { next(); return; }

        // ── POST routes ───────────────────────────────────────────────────────

        if (urlPath === '/api/cancel-search') { await handleCancelSearch(req, res); return; }
        if (urlPath === '/api/quick-search')  { await handleQuickSearch(req, res);  return; }
        if (urlPath === '/api/deep-search')   { await handleDeepSearch(req, res);   return; }
        if (urlPath === '/api/cache/clear')   { await handleCacheClear(req, res);   return; }
        if (urlPath === '/api/ai-filter')     { await handleAiFilter(req, res);     return; }
        if (urlPath === '/api/discover')      { await handleDiscover(req, res);     return; }
        if (urlPath === '/api/saved-searches') { await handleCreateSavedSearch(req, res); return; }

        next();
      });
    },
  }],
});
