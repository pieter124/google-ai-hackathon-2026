import { h } from "../reactRuntime.js";
import { CRITERIA_DEFINITIONS, getInterviewer, LANGUAGE_OPTIONS } from "../config.js";
import { ScoreDots } from "./CriteriaMatrix.js";
import PathChart from "./PathChart.js";

function labelFor(id) {
  const def = CRITERIA_DEFINITIONS.find((c) => c.id === id);
  return def ? def.label : id;
}

const VERDICT_PRESENTATION = {
  hire: { label: "Hire", className: "verdict-hire" },
  "lean-hire": { label: "Lean hire", className: "verdict-lean-hire" },
  "lean-no-hire": { label: "Lean no-hire", className: "verdict-lean-no-hire" },
  "no-hire": { label: "No hire", className: "verdict-no-hire" },
};

export default function ScorecardScreen({
  scorecard,
  problem,
  settings,
  lastTestResults,
  fillerStats,
  watchdogNudgeCount,
  progressSeries,
  onRestart,
}) {
  const interviewer = getInterviewer(settings.interviewerId);
  const languageLabel = (LANGUAGE_OPTIONS.find((l) => l.id === settings.language) || LANGUAGE_OPTIONS[0]).label;
  const passed = lastTestResults.filter((t) => t.passed).length;
  const total = lastTestResults.length;
  const fillerPct = fillerStats.totalWords > 0 ? Math.round(fillerStats.ratio * 100) : 0;
  const verdictStyle = VERDICT_PRESENTATION[scorecard.verdictDecision] || { label: "Verdict", className: "" };

  return h(
    "div",
    { className: "screen scorecard-screen" },
    h(
      "div",
      { className: "scorecard-card" },
      h(
        "div",
        { className: "scorecard-header" },
        h("h1", null, "Coaching Scorecard"),
        h(
          "p",
          { className: "scorecard-context" },
          `${problem.title} · ${languageLabel} · interviewed by ${interviewer.name}`
        )
      ),

      h(
        "div",
        { className: `scorecard-block verdict-block ${verdictStyle.className}` },
        h("h3", null, "Verdict"),
        h("p", { className: "verdict-decision" }, verdictStyle.label),
        h("p", null, scorecard.verdict)
      ),

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
                  h(
                    "div",
                    { className: "criteria-label-row" },
                    h("span", { className: "criteria-label" }, labelFor(c.id)),
                    h("span", { className: "criteria-score" }, `${c.score}/5`)
                  ),
                  h(ScoreDots, { score: c.score }),
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
          total === 0
            ? h("p", { className: "big-stat" }, "Never ran the code")
            : h("p", { className: "big-stat" }, `${passed} / ${total} tests passed`),
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
        h("h3", null, "Your path to the solution"),
        h(PathChart, { series: progressSeries }),
        h("p", { className: "path-narrative" }, scorecard.pathNarrative)
      ),

      h(
        "div",
        { className: "scorecard-row" },
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Filler words"),
          h("p", { className: "big-stat" }, `${fillerPct}%`),
          h(
            "p",
            { className: "muted" },
            `${fillerStats.fillerCount} filler words across ${fillerStats.totalWords} spoken words (local regex, not a hard filter)`
          )
        ),
        h(
          "div",
          { className: "scorecard-block" },
          h("h3", null, "Proactive nudges"),
          h("p", { className: "big-stat" }, String(watchdogNudgeCount)),
          h("p", { className: "muted" }, "Times the interviewer had to step in because you seemed stuck.")
        )
      ),

      h("button", { className: "btn btn-primary", onClick: onRestart }, "Practice again")
    )
  );
}
