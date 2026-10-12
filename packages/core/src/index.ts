/**
 * @ma/core — pure domain logic for Music Assistant.
 *
 * This package must stay dependency-free and side-effect-free: everything here
 * is unit-tested pure functions consumed by both the server and the CLI.
 * Domain features (quota formula, title normalization, track selection, policy
 * engine) land here in Phases 1-6.
 */

export const MA_CORE_VERSION = "0.0.0";

/** Clamps a number into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
