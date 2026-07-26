import { h } from "../reactRuntime.js";
import { RUBRIC } from "../config.js";

const DOTS = [1, 2, 3, 4, 5];

// Live, on-screen scorecard preview (ported from the team's `main` branch and
// unified onto our research-backed RUBRIC). Shown to the candidate throughout
// the interview — Agent 1's per-turn updates and Agent 2's checkpoint updates
// both feed `liveCriteria` (the merged latest-value-per-criterion view), so
// the same five dimensions that anchor the final report visibly move in real
// time. Replaces the old hidden "interviewer impressions".
export default function CriteriaMatrix({ liveCriteria }) {
  return h(
    "div",
    { className: "criteria-matrix" },
    h("h3", null, "Criteria · live"),
    RUBRIC.map((def) => {
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
        )
      );
    })
  );
}
