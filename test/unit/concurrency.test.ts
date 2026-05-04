import { describe, expect, it } from "vitest";
import { pLimited } from "../../src/concurrency.js";

describe("pLimited", () => {
  it("returns results in the same order as input", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await pLimited(items, 2, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("handles empty array", async () => {
    const results = await pLimited([], 4, async (x: number) => x);
    expect(results).toEqual([]);
  });

  it("runs with n=1 (sequential)", async () => {
    const order: number[] = [];
    const items = [3, 1, 2];
    await pLimited(items, 1, async (x) => {
      order.push(x);
      return x;
    });
    expect(order).toEqual([3, 1, 2]);
  });

  it("respects concurrency cap", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await pLimited(items, 3, async (_x) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Yield to allow other promises to start.
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("single-item array works", async () => {
    const results = await pLimited([42], 8, async (x) => x + 1);
    expect(results).toEqual([43]);
  });

  it("clamps n < 1 to 1", async () => {
    const results = await pLimited([1, 2, 3], 0, async (x) => x);
    expect(results).toEqual([1, 2, 3]);
  });
});
