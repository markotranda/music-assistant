import { describe, expect, it } from "vitest";
import { cleanTitle, foldText, isAltVersion, normTitle, safeName } from "../src/index";
import { textFixture } from "./fixtures";

describe("text pipeline — legacy golden parity", () => {
  it.each(textFixture.titles.map((t) => [t.input, t] as const))(
    "normalizes %s exactly like the legacy tool",
    (_input, golden) => {
      expect(foldText(golden.input)).toBe(golden.fold);
      expect(cleanTitle(golden.input)).toBe(golden.clean);
      expect(normTitle(golden.input)).toBe(golden.norm);
    },
  );

  it.each(textFixture.safeNames.map((s) => [s.input, s] as const))(
    "safe-names %s like the legacy tool",
    (_input, golden) => {
      expect(safeName(golden.input)).toBe(golden.safe);
    },
  );

  it.each(textFixture.altVersions.map((a) => [a.input, a] as const))(
    "classifies %s like the legacy tool",
    (_input, golden) => {
      expect(isAltVersion(golden.input)).toBe(golden.alt);
    },
  );
});

describe("text pipeline — documented invariants", () => {
  it("keeps real titles that contain version words", () => {
    expect(normTitle("Live Wire")).toBe("livewire");
    expect(normTitle("Live and Let Die")).toBe("liveandletdie");
    expect(cleanTitle("White Wedding - Pt. 1")).toBe("White Wedding - Pt. 1");
  });

  it("falls apart gracefully on empty input", () => {
    expect(foldText("")).toBe("");
    expect(foldText(null)).toBe("");
    expect(normTitle(undefined)).toBe("");
    expect(normTitle("!!!")).toBe("");
  });
});
