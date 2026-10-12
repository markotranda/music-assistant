import { readFileSync } from "node:fs";

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export type TextFixture = {
  titles: { input: string; fold: string; clean: string; norm: string }[];
  safeNames: { input: string; safe: string }[];
  altVersions: { input: string; alt: boolean }[];
};

export type QuotaFixture = {
  bands: {
    band: string;
    score: number;
    catalog: number;
    csvQuota: number;
    computedQuota: number;
  }[];
  edges: { score: number; catalog: number; quota: number }[];
};

export type SelectionFixture = {
  cases: { name: string; score: number; quota: number; count: number; picks: string[] }[];
};

export const textFixture = load<TextFixture>("text.json");
export const quotaFixture = load<QuotaFixture>("quota.json");
export const selectionFixture = load<SelectionFixture>("selection.json");

/** Rebuilds the synthetic ranked list used to generate selection fixtures. */
export function syntheticRanked(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const title = `Song ${String(n).padStart(2, "0")}`;
    return {
      title,
      norm: title.toLowerCase().replace(/[^a-z0-9]/g, ""),
      plays: 1000 - n,
    };
  });
}
