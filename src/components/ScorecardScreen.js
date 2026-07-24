import { h } from "../reactRuntime.js";

export default function ScorecardScreen({ scorecard, lastTestResults, onRestart }) {
  const passed = lastTestResults.filter((t) => t.passed).length;
  const total = lastTestResults.length;

  return h(
    "div",
    { className: "screen scorecard-screen" },
    h(
      "div",
      { className: "scorecard-card" },
      h("h1", null, "Coaching Scorecard"),

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
        h("h3", null, "Strengths"),
        h(
          "ul",
          null,
          scorecard.strengths.length === 0
            ? h("li", { className: "muted" }, "No strengths recorded.")
            : scorecard.strengths.map((s, i) => h("li", { key: i }, s.note))
        )
      ),

      h(
        "div",
        { className: "scorecard-block" },
        h("h3", null, "Areas to improve"),
        h(
          "ul",
          null,
          scorecard.improvements.length === 0
            ? h("li", { className: "muted" }, "No improvement notes recorded.")
            : scorecard.improvements.map((imp, i) =>
                h("li", { key: i }, h("strong", null, imp.note), ` — ${imp.suggestion}`)
              )
        )
      ),

      h(
        "div",
        { className: "scorecard-row" },
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Communication"),
          h("p", null, scorecard.communicationNote)
        ),
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Hints used"),
          h("p", { className: "big-stat" }, String(scorecard.hintsUsed))
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
