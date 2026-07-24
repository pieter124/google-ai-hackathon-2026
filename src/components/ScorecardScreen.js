import { h } from "../reactRuntime.js";
import { CRITERIA_DEFINITIONS } from "../config.js";

function labelFor(id) {
  const def = CRITERIA_DEFINITIONS.find((c) => c.id === id);
  return def ? def.label : id;
}

export default function ScorecardScreen({ scorecard, lastTestResults, fillerStats, watchdogNudgeCount, onRestart }) {
  const passed = lastTestResults.filter((t) => t.passed).length;
  const total = lastTestResults.length;
  const fillerPct = fillerStats.totalWords > 0 ? Math.round(fillerStats.ratio * 100) : 0;

  return h(
    "div",
    { className: "screen scorecard-screen" },
    h(
      "div",
      { className: "scorecard-card" },
      h("h1", null, "Coaching Scorecard"),

      h(
        "div",
        { className: "scorecard-block" },
        h("h3", null, "Criteria scores"),
        h(
          "div",
          { className: "final-criteria-list" },
          scorecard.criteriaScores.length === 0
            ? h("p", { className: "muted" }, "No criteria were scored this session.")
            : scorecard.criteriaScores.map((c, i) =>
                h(
                  "div",
                  { key: i, className: "final-criteria-row" },
                  h("span", { className: "criteria-label" }, labelFor(c.id)),
                  h("span", { className: "criteria-score" }, `${c.score}/5`),
                  h("p", { className: "criteria-note" }, c.note)
                )
              )
        )
      ),

      h(
        "div",
        { className: "scorecard-row" },
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Correctness"),
          h("p", { className: "big-stat" }, `${passed} / ${total} tests passed`),
          h("p", null, scorecard.correctness)
        ),
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Estimated complexity"),
          h("p", null, scorecard.complexity)
        )
      ),

      h(
        "div",
        { className: "scorecard-block" },
        h("h3", null, "Path narrative"),
        h("p", null, scorecard.pathNarrative)
      ),

      h(
        "div",
        { className: "scorecard-row" },
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Filler words"),
          h("p", { className: "big-stat" }, `${fillerPct}%`),
          h("p", { className: "muted" }, `${fillerStats.fillerCount} filler words across ${fillerStats.totalWords} spoken words (local regex, not a hard filter)`)
        ),
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Proactive nudges"),
          h("p", { className: "big-stat" }, String(watchdogNudgeCount))
        )
      ),

      h(
        "div",
        { className: "scorecard-block verdict-block" },
        h("h3", null, "Verdict"),
        h("p", null, scorecard.verdict)
      ),

      h("button", { className: "btn btn-primary", onClick: onRestart }, "Restart")
    )
  );
}
