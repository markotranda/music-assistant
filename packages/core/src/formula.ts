import type { ScoreTier } from "./types.js";

/**
 * The proven quota formula, ported from the legacy tool:
 *
 *   quota = clamp(round(multiplier[score] × √catalog), floor[score], cap[score], catalog)
 *
 * Sub-linear (√) so big catalogs don't explode; floors/caps bound each tier.
 * "Small errors in catalog estimation barely move the result."
 */
export type QuotaFormula = {
  multipliers: Record<ScoreTier, number>;
  floors: Record<ScoreTier, number>;
  caps: Record<ScoreTier, number>;
  /** Share of a score-3 quota spent on deep cuts instead of top hits. */
  deepShare: number;
};

/** Legacy config.json defaults. Tunable in Settings. */
export const DEFAULT_QUOTA_FORMULA: QuotaFormula = {
  multipliers: { 1: 0.65, 2: 1.15, 3: 2.0 },
  floors: { 1: 3, 2: 5, 3: 8 },
  caps: { 1: 7, 2: 20, 3: 30 },
  deepShare: 0.35,
};

/**
 * Rounds half to even ("banker's rounding"), matching .NET `Math.Round` which
 * the legacy PowerShell tool used. `Math.round` (half up) would shift some
 * bands' quotas by 1 — the golden fixtures pin this behavior.
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Quota for one band. Preserves the legacy clamp order: floor, cap, catalog. */
export function getQuota(
  score: ScoreTier,
  catalog: number,
  formula: QuotaFormula = DEFAULT_QUOTA_FORMULA,
): number {
  let v = roundHalfToEven(formula.multipliers[score] * Math.sqrt(catalog));
  if (v < formula.floors[score]) v = formula.floors[score];
  if (v > formula.caps[score]) v = formula.caps[score];
  if (v > catalog) v = catalog;
  return v;
}
