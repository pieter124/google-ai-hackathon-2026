// Last-write-wins merge over the criteriaLog, used for both prompt context and
// the live Criteria Matrix. Each entry is { timestamp, source, criteriaUpdate }
// and only carries the criteria it has signal for, so later entries update some
// ids and leave others untouched.
export function mergeCriteriaLog(criteriaLog) {
  const merged = {};
  for (const entry of criteriaLog) {
    for (const [id, value] of Object.entries(entry.criteriaUpdate || {})) {
      merged[id] = { ...value, updatedAt: entry.timestamp, source: entry.source };
    }
  }
  return merged;
}
