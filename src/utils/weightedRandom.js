import { PROBLEM_BANK, DIFFICULTY_WEIGHTS } from "../config.js";

// Picks a problem using the per-difficulty weights in config. Zero-weight
// difficulties (easy, per the "medium minimum" requirement) are simply never
// rolled. We build a cumulative-weight array once per call and binary-search a
// single random draw into it — no bias toward any difficulty beyond the
// weights, and no dependency on how many problems each difficulty happens to
// have. `excludeId` lets the "Randomize" button reroll to a *different*
// problem instead of possibly returning the same one.
export function pickWeightedProblem(excludeId = null) {
  const pool = PROBLEM_BANK.filter(
    (p) => (DIFFICULTY_WEIGHTS[p.difficulty] || 0) > 0 && p.id !== excludeId
  );
  // If excluding the current problem emptied the pool (e.g. only one eligible
  // problem exists), fall back to the full eligible set so we still return one.
  const candidates = pool.length
    ? pool
    : PROBLEM_BANK.filter((p) => (DIFFICULTY_WEIGHTS[p.difficulty] || 0) > 0);

  const cumulative = [];
  let total = 0;
  for (const p of candidates) {
    total += DIFFICULTY_WEIGHTS[p.difficulty];
    cumulative.push(total);
  }

  const draw = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    if (draw < cumulative[i]) return candidates[i];
  }
  return candidates[candidates.length - 1]; // floating-point safety net
}
