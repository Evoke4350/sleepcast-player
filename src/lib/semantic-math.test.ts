import { describe, expect, it } from "vitest";
import { cosine, diversePick, rankBySimilarity } from "./semantic-math";

const v = (...xs: number[]) => new Float32Array(xs);

describe("cosine", () => {
  it("is 1 for identical directions, 0 for orthogonal", () => {
    expect(cosine(v(1, 0), v(2, 0))).toBeCloseTo(1);
    expect(cosine(v(1, 0), v(0, 5))).toBeCloseTo(0);
  });
  it("handles zero vectors without NaN", () => {
    expect(cosine(v(0, 0), v(1, 0))).toBe(0);
  });
});

describe("rankBySimilarity", () => {
  it("orders indices by similarity to the query", () => {
    const q = v(1, 0);
    const items = [v(0, 1), v(1, 0.1), v(0.7, 0.7)];
    expect(rankBySimilarity(q, items)).toEqual([1, 2, 0]);
  });
});

describe("diversePick", () => {
  it("greedily spreads picks across the space", () => {
    // Two tight clusters + one outlier; picking 3 should hit both clusters
    // and the outlier rather than 3 from one cluster.
    const items = [
      v(1, 0), v(0.99, 0.01), v(0.98, 0.02), // cluster A
      v(0, 1), v(0.01, 0.99),                // cluster B
      v(-1, 0),                              // outlier
    ];
    const picks = diversePick(items, 3, () => 0);
    const clusters = new Set(picks.map((i) => (i <= 2 ? "A" : i <= 4 ? "B" : "C")));
    expect(clusters.size).toBe(3);
  });

  it("returns all indices when n >= items", () => {
    expect(diversePick([v(1, 0), v(0, 1)], 5, () => 0).length).toBe(2);
  });

  it("is deterministic given a fixed rand", () => {
    const items = [v(1, 0), v(0, 1), v(-1, 0), v(0, -1)];
    expect(diversePick(items, 2, () => 0.5)).toEqual(diversePick(items, 2, () => 0.5));
  });
});
