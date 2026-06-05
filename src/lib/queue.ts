export class ConcurrencyQueue {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(() => {
        fn().then(resolve, reject).finally(() => {
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

const registry = new Map<string, ConcurrencyQueue>();

function getQueue(url: string): ConcurrencyQueue {
  let hostname: string;
  try { hostname = new URL(url).hostname; }
  catch { hostname = url; }
  if (!registry.has(hostname)) {
    const concurrency =
      Object.entries(DOMAIN_CONCURRENCY).find(([d]) => hostname.endsWith(d))?.[1] ?? 2;
    registry.set(hostname, new ConcurrencyQueue(concurrency));
  }
  return registry.get(hostname)!;
}

export function enqueue<T>(url: string, fn: () => Promise<T>): Promise<T> {
  return getQueue(url).add(fn);
}
