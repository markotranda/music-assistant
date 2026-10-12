import { describe, expect, it } from "vitest";
import { clamp, MA_CORE_VERSION } from "../src/index";

describe("clamp", () => {
  it("returns the value when inside the range", () => {
    expect(clamp(5, 1, 10)).toBe(5);
  });

  it("clamps to the minimum", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps to the maximum", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });
});

describe("MA_CORE_VERSION", () => {
  it("is a semver string", () => {
    expect(MA_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
