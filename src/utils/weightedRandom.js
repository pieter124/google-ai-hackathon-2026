import { PROBLEM_BANK, DIFFICULTY_WEIGHTS } from "../config.js";

// Picks a problem by DIFFICULTY weight, then uniformly within that difficulty —
// so DIFFICULTY_WEIGHTS means what it says (a 50/30/20 split stays 50/30/20)
// regardless of how many problems each difficulty happens to have. Weighting
// per-problem instead would let a difficulty's share drift with its problem
// count. Zero-weight difficulties (easy, per the "medium minimum" rule) are
// never rolled. `excludeId` lets the Randomize button reroll to a *different*
// problem when possible.
export function pickWeightedProblem(excludeId = null) {
  // Difficulties that have at least one problem and a non-zero weight.
  const byDifficulty = new Map();
  for (const p of PROBLEM_BANK) {
    if ((DIFFICULTY_WEIGHTS[p.difficulty] || 0) <= 0) continue;
    if (!byDifficulty.has(p.difficulty)) byDifficulty.set(p.difficulty, []);
    byDifficulty.get(p.difficulty).push(p);
  }

  const difficulties = [...byDifficulty.keys()];
  const total = difficulties.reduce((s, d) => s + DIFFICULTY_WEIGHTS[d], 0);

  // Weighted pick of a difficulty (linear scan over the small difficulty set).
  let draw = Math.random() * total;
  let chosenDifficulty = difficulties[difficulties.length - 1]; // float safety net
  for (const d of difficulties) {
    draw -= DIFFICULTY_WEIGHTS[d];
    if (draw < 0) { chosenDifficulty = d; break; }
  }

  const pool = byDifficulty.get(chosenDifficulty);
  const eligible = pool.filter((p) => p.id !== excludeId);
  // If excluding emptied this difficulty (only one problem in it), fall back to
  // the full pool so we still return something rather than reroll forever.
  const candidates = eligible.length ? eligible : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
