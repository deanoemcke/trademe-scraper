// Server-side only — manages search lifecycle via AbortController.
// Both quick-search (searchId) and deep-search (deepSearchId) use this module.

const controllers = new Map<string, AbortController>();

export function registerSearch(id: string): AbortSignal {
  const controller = new AbortController();
  controllers.set(id, controller);
  return controller.signal;
}

export function cancelSearch(id: string): void {
  const controller = controllers.get(id);
  if (controller) controller.abort();
}

export function isSearchCancelled(id: string): boolean {
  const controller = controllers.get(id);
  return controller?.signal.aborted ?? false;
}

export function cleanupSearch(id: string): void {
  controllers.delete(id);
}
