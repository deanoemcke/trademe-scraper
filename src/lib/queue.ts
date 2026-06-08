export class ConcurrencyQueue {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
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

const DOMAIN_CONCURRENCY: Record<string, number> = {
  'trademe.co.nz': 3,
  'facebook.com': 2,
};

function resolveHostname(url: string): string {
  try { return new URL(url).hostname; }
  catch { return url; }
}

export function createRegistry(): <T>(url: string, fn: () => Promise<T>) => Promise<T> {
  const reg = new Map<string, ConcurrencyQueue>();
  return function enqueueInRegistry<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const hostname = resolveHostname(url);
    if (!reg.has(hostname)) {
      const concurrency =
        Object.entries(DOMAIN_CONCURRENCY).find(([d]) => hostname.endsWith(d))?.[1] ?? 2;
      reg.set(hostname, new ConcurrencyQueue(concurrency));
    }
    return reg.get(hostname)!.add(fn);
  };
}

export const enqueue = createRegistry();
