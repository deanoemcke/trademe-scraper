import { describe, it, expect } from 'vitest';
import { ConcurrencyQueue, enqueue } from './queue';

// A deferred task: doesn't resolve until you call finish().
function makeTask<T = void>(value: T) {
  let finish!: () => void;
  const promise = new Promise<void>(r => { finish = r; });
  const fn = () => promise.then(() => value);
  return { fn, finish };
}

describe('ConcurrencyQueue', () => {
  it('runs tasks up to the concurrency limit', async () => {
    const queue = new ConcurrencyQueue(2);
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 5 }, () => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await blocker;
        active--;
      };
      return { fn, finish };
    });

    const all = Promise.all(tasks.map(t => queue.add(t.fn)));
    await Promise.resolve();

    // First batch: exactly 2 running immediately
    expect(active).toBe(2);

    // Finish all and verify the limit was never exceeded
    tasks.forEach(t => t.finish());
    await all;
    expect(maxActive).toBe(2);
    expect(active).toBe(0);
  });

  it('returns the resolved value of each task', async () => {
    const queue = new ConcurrencyQueue(2);
    const t1 = makeTask('a');
    const t2 = makeTask('b');

    const results = Promise.all([queue.add(t1.fn), queue.add(t2.fn)]);
    t1.finish();
    t2.finish();

    expect(await results).toEqual(['a', 'b']);
  });

  it('drains remaining tasks after a slot frees up', async () => {
    const queue = new ConcurrencyQueue(1);
    const order: number[] = [];

    const tasks = [1, 2, 3].map(n => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => { await blocker; order.push(n); };
      return { fn, finish };
    });

    const all = Promise.all(tasks.map(t => queue.add(t.fn)));
    await Promise.resolve();

    tasks[0].finish();
    await Promise.resolve(); await Promise.resolve();
    tasks[1].finish();
    await Promise.resolve(); await Promise.resolve();
    tasks[2].finish();
    await all;

    expect(order).toEqual([1, 2, 3]);
  });

  it('two queues with different limits run simultaneously without blocking each other', async () => {
    const tradeMe = new ConcurrencyQueue(3); // trademe.co.nz
    const facebook = new ConcurrencyQueue(2); // facebook.com

    let tradeMeActive = 0;
    let facebookActive = 0;
    let maxTradeMe = 0;
    let maxFacebook = 0;
    let maxCombined = 0;

    const makeDomainTask = (counter: { active: number; max: number }) => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => {
        counter.active++;
        counter.max = Math.max(counter.max, counter.active);
        maxCombined = Math.max(maxCombined, tradeMeActive + facebookActive);
        await blocker;
        counter.active--;
      };
      return { fn, finish };
    };

    const tmCounters = { active: tradeMeActive, max: maxTradeMe };
    const fbCounters = { active: facebookActive, max: maxFacebook };

    // Workaround: use shared objects so mutations are visible
    const tmActive = { v: 0, max: 0 };
    const fbActive = { v: 0, max: 0 };

    const tmTasks = Array.from({ length: 5 }, () => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => {
        tmActive.v++;
        tmActive.max = Math.max(tmActive.max, tmActive.v);
        maxCombined = Math.max(maxCombined, tmActive.v + fbActive.v);
        await blocker;
        tmActive.v--;
      };
      return { fn, finish };
    });

    const fbTasks = Array.from({ length: 4 }, () => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => {
        fbActive.v++;
        fbActive.max = Math.max(fbActive.max, fbActive.v);
        maxCombined = Math.max(maxCombined, tmActive.v + fbActive.v);
        await blocker;
        fbActive.v--;
      };
      return { fn, finish };
    });

    const all = Promise.all([
      ...tmTasks.map(t => tradeMe.add(t.fn)),
      ...fbTasks.map(t => facebook.add(t.fn)),
    ]);
    await Promise.resolve();

    // Each queue should be at its own limit, and both running at the same time
    expect(tmActive.v).toBe(3);
    expect(fbActive.v).toBe(2);
    expect(maxCombined).toBeGreaterThanOrEqual(5); // both queues active simultaneously

    [...tmTasks, ...fbTasks].forEach(t => t.finish());
    await all;

    expect(tmActive.max).toBe(3);
    expect(fbActive.max).toBe(2);
    expect(tmActive.v).toBe(0);
    expect(fbActive.v).toBe(0);
  });
});

// ── makeBlocker: a task that blocks until you call finish() ───────────────────

function makeBlocker(counter: { v: number; max: number }, combinedRef?: { v: number }) {
  let finish!: () => void;
  const blocker = new Promise<void>(r => { finish = r; });
  const fn = async () => {
    counter.v++;
    counter.max = Math.max(counter.max, counter.v);
    if (combinedRef) combinedRef.v = Math.max(combinedRef.v, counter.v);
    await blocker;
    counter.v--;
  };
  return { fn, finish };
}

describe('enqueue — pagination concurrency', () => {
  it('paginated TradeMe URLs (same hostname, different ?page=N) share one queue and start concurrently', async () => {
    const searchUrl = 'https://www.trademe.co.nz/a/marketplace/search?search_string=macbook';
    const totalPages = 5;
    let active = 0;
    let maxActive = 0;

    // Mirror the exact pattern from quickSearch
    const tasks = Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map(p => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const u = new URL(searchUrl);
      u.searchParams.set('page', String(p));
      const pageUrl = u.toString();
      const fn = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await blocker;
        active--;
      };
      return { pageUrl, fn, finish };
    });

    // Enqueue all pagination pages exactly as quickSearch does
    const all = Promise.all(tasks.map(t => enqueue(t.pageUrl, t.fn)));
    await Promise.resolve();

    // trademe.co.nz has limit 3, so 3 of the 4 pages should be active immediately
    expect(active).toBe(3);

    tasks.forEach(t => t.finish());
    await all;

    expect(maxActive).toBe(3);
    expect(active).toBe(0);
  });
});

describe('enqueue (domain registry)', () => {
  it('two searches for the same domain share a single concurrency limit', async () => {
    const active = { v: 0, max: 0 };

    // 6 tasks for trademe.co.nz (domain limit = 3)
    const tasks = Array.from({ length: 6 }, () => makeBlocker(active));

    const all = Promise.all(
      tasks.map(t => enqueue('https://www.trademe.co.nz/a/listing/123', t.fn))
    );
    await Promise.resolve();

    expect(active.v).toBe(3); // shared limit enforced across both "searches"

    tasks.forEach(t => t.finish());
    await all;

    expect(active.max).toBe(3);
    expect(active.v).toBe(0);
  });

  it('different domains run concurrently each respecting their own limit', async () => {
    const tmActive = { v: 0, max: 0 };
    const fbActive = { v: 0, max: 0 };
    let combinedMax = 0;

    const tmTasks = Array.from({ length: 5 }, () => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => {
        tmActive.v++;
        tmActive.max = Math.max(tmActive.max, tmActive.v);
        combinedMax = Math.max(combinedMax, tmActive.v + fbActive.v);
        await blocker;
        tmActive.v--;
      };
      return { fn, finish };
    });

    const fbTasks = Array.from({ length: 4 }, () => {
      let finish!: () => void;
      const blocker = new Promise<void>(r => { finish = r; });
      const fn = async () => {
        fbActive.v++;
        fbActive.max = Math.max(fbActive.max, fbActive.v);
        combinedMax = Math.max(combinedMax, tmActive.v + fbActive.v);
        await blocker;
        fbActive.v--;
      };
      return { fn, finish };
    });

    const all = Promise.all([
      ...tmTasks.map(t => enqueue('https://www.trademe.co.nz/a/listing/1', t.fn)),
      ...fbTasks.map(t => enqueue('https://www.facebook.com/marketplace/item/1/', t.fn)),
    ]);
    await Promise.resolve();

    // Each domain is at its own limit simultaneously
    expect(tmActive.v).toBe(3);
    expect(fbActive.v).toBe(2);
    expect(combinedMax).toBeGreaterThanOrEqual(5); // both domains active at the same time

    [...tmTasks, ...fbTasks].forEach(t => t.finish());
    await all;

    expect(tmActive.max).toBe(3);
    expect(fbActive.max).toBe(2);
    expect(tmActive.v).toBe(0);
    expect(fbActive.v).toBe(0);
  });
});
