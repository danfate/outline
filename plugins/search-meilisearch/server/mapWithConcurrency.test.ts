import { mapWithConcurrency } from "./mapWithConcurrency";

describe("mapWithConcurrency", () => {
  it("limits concurrent work while preserving input order", async () => {
    let active = 0;
    let maximumActive = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return item * 2;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([2, 4, 6, 8]);
  });
});
