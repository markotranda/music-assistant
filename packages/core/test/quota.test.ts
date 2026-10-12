import { describe, expect, it } from "vitest";
import type { ScoreTier } from "../src/index";
import { DEFAULT_QUOTA_FORMULA, getQuota, roundHalfToEven } from "../src/index";
import { quotaFixture } from "./fixtures";

describe("roundHalfToEven — .NET Math.Round parity", () => {
  it("rounds midpoints to the even neighbor", () => {
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(3.5)).toBe(4);
    expect(roundHalfToEven(6.5)).toBe(6);
    expect(roundHalfToEven(7.5)).toBe(8);
  });

  it("rounds non-midpoints normally", () => {
    expect(roundHalfToEven(2.4)).toBe(2);
    expect(roundHalfToEven(2.6)).toBe(3);
    expect(roundHalfToEven(0)).toBe(0);
  });

  it("differs from Math.round on midpoints (why this exists)", () => {
    expect(Math.round(6.5)).toBe(7);
    expect(roundHalfToEven(6.5)).toBe(6);
  });
});

describe("getQuota — legacy golden parity", () => {
  it.each(quotaFixture.edges.map((e) => [`${e.score}/${e.catalog}`, e] as const))(
    "matches legacy for score/catalog %s",
    (_label, golden) => {
      expect(getQuota(golden.score as ScoreTier, golden.catalog)).toBe(golden.quota);
    },
  );

  it.each(quotaFixture.bands.map((b) => [b.band, b] as const))(
    "reproduces the legacy quota for %s",
    (_band, golden) => {
      const quota = getQuota(golden.score as ScoreTier, golden.catalog);
      expect(quota).toBe(golden.csvQuota);
      expect(quota).toBe(golden.computedQuota);
    },
  );

  it("applies the clamp order: floor, cap, then catalog", () => {
    const formula = DEFAULT_QUOTA_FORMULA;
    // catalog 1 at score 3: floor 8 -> cap 30 -> clamped to catalog 1.
    expect(getQuota(3, 1, formula)).toBe(1);
    // huge catalog at score 1 hits the cap.
    expect(getQuota(1, 10000, formula)).toBe(formula.caps[1]);
    // tiny catalog at score 1 hits the floor first.
    expect(getQuota(1, 1, formula)).toBe(1);
  });
});
