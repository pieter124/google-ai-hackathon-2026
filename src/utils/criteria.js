// Shared "last write wins per criterion" merge over the session's
// criteriaLog — used both to give Gemini prompt context (what's been scored
// so far) and to drive the live, visible Criteria Matrix panel. Each log
// entry looks like { timestamp, source: "turn" | "checkpoint" | "watchdog",
// criteriaUpdate: { [criterionId]: { score, note } } }; entries only need to
// carry the criteria they actually have signal for, so later entries update
// some ids and leave others untouched.
export function mergeCriteriaLog(criteriaLog) {
  const merged = {};
  for (const entry of criteriaLog) {
    for (const [id, value] of Object.entries(entry.criteriaUpdate || {})) {
      merged[id] = { ...value, updatedAt: entry.timestamp, source: entry.source };
    }
  }
  return merged;
}
