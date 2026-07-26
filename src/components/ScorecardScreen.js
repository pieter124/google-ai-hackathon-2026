import { h } from "../reactRuntime.js";
import PathChart from "./PathChart.js";

// Renders a 1-5 meter for one rubric dimension: five segments, `score` filled.
function ScoreMeter({ score }) {
  return h(
    "div",
    { className: "score-meter" },
    [1, 2, 3, 4, 5].map((n) =>
      h("span", { key: n, className: `meter-seg ${n <= score ? "filled" : ""}` })
    )
  );
}

export default function ScorecardScreen({ scorecard, lastTestResults, onRestart }) {
  // App only routes here after a successful report, but guard anyway so a
  // stray render can't throw instead of showing something.
  if (!scorecard) {
    return h(
      "div",
      { className: "screen scorecard-screen" },
      h("p", { className: "muted" }, "No scorecard available."),
      h("button", { className: "btn btn-primary", onClick: onRestart }, "Restart")
    );
  }

  const passed = lastTestResults.filter((t) => t.passed).length;
  const total = lastTestResults.length;
  const { scores, pathNarrative, verdict, hireDecision, hintsUsed, fillerStats, progressSeries } = scorecard;
  const avg = scores.length ? (scores.reduce((s, d) => s + d.score, 0) / scores.length).toFixed(1) : "—";

  return h(
    "div",
    { className: "screen scorecard-screen" },
    h(
      "div",
      { className: "scorecard-card" },
      h(
        "div",
        { className: "scorecard-head" },
        h("h1", null, "Coaching Scorecard"),
        hireDecision &&
          h("span", { className: `hire-badge hire-${hireDecision.toLowerCase().replace(/\s+/g, "-")}` }, hireDecision)
      ),

      // --- Rubric scores ---
      h(
        "div",
        { className: "scores-block" },
        scores.map((d) =>
          h(
            "div",
            { key: d.id, className: "score-row" },
            h(
              "div",
              { className: "score-head" },
              h("span", { className: "score-label" }, d.label),
              h("span", { className: "score-value" }, `${d.score}/5`)
            ),
            h(ScoreMeter, { score: d.score }),
            d.rationale && h("p", { className: "score-rationale" }, d.rationale)
          )
        )
      ),

      // --- Path trajectory ---
      h(
        "div",
        { className: "scorecard-block" },
        h("h3", null, "Your path to the solution"),
        h(PathChart, { series: progressSeries }),
        pathNarrative && h("p", { className: "path-narrative" }, pathNarrative)
      ),

      // --- Stats row ---
      h(
        "div",
        { className: "scorecard-row stats-row" },
        h(
          "div",
          { className: "stat-tile" },
          h("span", { className: "stat-num" }, `${passed}/${total}`),
          h("span", { className: "stat-cap" }, "tests passed")
        ),
        h(
          "div",
          { className: "stat-tile" },
          h("span", { className: "stat-num" }, avg),
          h("span", { className: "stat-cap" }, "avg score")
        ),
        h(
          "div",
          { className: "stat-tile" },
          h("span", { className: "stat-num" }, String(hintsUsed)),
          h("span", { className: "stat-cap" }, "hints / nudges")
        ),
        h(
          "div",
          { className: "stat-tile" },
          h("span", { className: "stat-num" }, `${(fillerStats.ratio * 100).toFixed(0)}%`),
          h("span", { className: "stat-cap" }, `filler words (${fillerStats.fillers}/${fillerStats.total})`)
        )
      ),
      h(
        "p",
        { className: "fairness-note" },
        "Filler rate is a coaching signal, not a grade — it partly reflects nerves and speaking style, so weigh it lightly."
      ),

      // --- Verdict ---
      verdict &&
        h(
          "div",
          { className: "scorecard-block verdict-block" },
          h("h3", null, "Verdict"),
          h("p", null, verdict)
        ),

      h("button", { className: "btn btn-primary", onClick: onRestart }, "New interview")
    )
  );
}
