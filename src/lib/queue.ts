export class ConcurrencyQueue {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  add<T>(asyncTask: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        Promise.resolve().then(asyncTask).then(resolve, reject).finally(() => {
          this.active--;
          this.drain();
        });
      });
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      this.active++;
      this.queue.shift()!();
    }
  }
}

// ── Domain registry ───────────────────────────────────────────────────────────

const CONCURRENCY_LIMIT_BY_DOMAIN: Record<string, number> = {
  'trademe.co.nz': 3,
  'facebook.com': 2,
};

function resolveHostname(url: string): string {
  try { return new URL(url).hostname; }
  catch { return url; }
}

export function createRegistry(): <T>(url: string, asyncTask: () => Promise<T>) => Promise<T> {
  const queueByHostname = new Map<string, ConcurrencyQueue>();
  return function enqueueInRegistry<T>(url: string, asyncTask: () => Promise<T>): Promise<T> {
    const hostname = resolveHostname(url);
    if (!queueByHostname.has(hostname)) {
      const concurrency =
        Object.entries(CONCURRENCY_LIMIT_BY_DOMAIN).find(([domain]) => hostname.endsWith(domain))?.[1] ?? 2;
      queueByHostname.set(hostname, new ConcurrencyQueue(concurrency));
    }
    return queueByHostname.get(hostname)!.add(asyncTask);
  };
}

export const enqueue = createRegistry();
