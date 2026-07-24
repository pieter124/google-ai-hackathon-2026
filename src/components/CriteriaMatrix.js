import { h } from "../reactRuntime.js";
import { CRITERIA_DEFINITIONS } from "../config.js";

const DOTS = [1, 2, 3, 4, 5];

// Visible, live-updating scorecard preview — deliberately shown to the
// candidate throughout the interview (per the spec), not hidden like the
// old private "interviewerImpressions" concept it replaces. Fed by
// `liveCriteria`, the merged latest-value-per-criterion view of the shared
// criteriaLog (Agent 1's per-turn updates + Agent 2's checkpoint updates).
export default function CriteriaMatrix({ liveCriteria }) {
  return h(
    "div",
    { className: "criteria-matrix" },
    h("h3", null, "Criteria (live)"),
    CRITERIA_DEFINITIONS.map((def) => {
      const entry = liveCriteria[def.id];
      const score = entry ? entry.score : 0;
      return h(
        "div",
        { key: def.id, className: "criteria-row" },
        h(
          "div",
          { className: "criteria-label-row" },
          h("span", { className: "criteria-label" }, def.label),
          h("span", { className: "criteria-score" }, entry ? `${entry.score}/5` : "—")
        ),
        h(
          "div",
          { className: "criteria-bar" },
          DOTS.map((i) => h("span", { key: i, className: `criteria-dot${i <= score ? " filled" : ""}` }))
        ),
        entry && entry.note ? h("p", { className: "criteria-note" }, entry.note) : null
      );
    })
  );
}
