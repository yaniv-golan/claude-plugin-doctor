/**
 * In-tree N-slot concurrency limiter (spec §4 + §13.3 + §18.4).
 *
 * A simple worker-pool pattern: at most `n` promises run in parallel.
 * Resolves with the results in the same order as the input items.
 *
 * No external dependency — keeps the ≤5 runtime dep budget.
 */

export async function pLimited<T, R>(
  items: T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, n);
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      // biome-ignore lint/style/noNonNullAssertion: idx is bounds-checked above
      results[idx] = await fn(items[idx]!, idx);
    }
  }

  // Launch min(cap, items.length) workers concurrently.
  const workerCount = Math.min(cap, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
