import { h } from "../reactRuntime.js";
import { INTERVIEWER_DIFFICULTIES, SESSION_LENGTHS, IS_API_KEY_SET } from "../config.js";

// First screen: pick how tough the interviewer is, roll a problem (medium+),
// pick a length, go. The problem is shown before starting so the candidate can
// reroll — the "Randomize" button is the primary blue action here.
export default function SetupScreen({ settings, problem, onChangeSettings, onRandomize, onStart }) {
  return h(
    "div",
    { className: "screen setup-screen" },
    h(
      "div",
      { className: "setup-card" },
      h("h1", null, "Mock Interview Agent"),
      h(
        "p",
        { className: "subtitle" },
        "A live coding interview against an AI interviewer — voice, real editor, real test cases."
      ),

      !IS_API_KEY_SET() &&
        h(
          "div",
          { className: "notice" },
          "No API key set. In devtools run ",
          h("code", null, "localStorage.GOOGLE_API_KEY='YOUR_KEY'"),
          " (restricted to Gemini + Speech-to-Text + Text-to-Speech), then reload."
        ),

      // --- Interviewer difficulty (persona) ---
      h("h2", { className: "field-label" }, "Interviewer"),
      h(
        "div",
        { className: "difficulty-cards" },
        INTERVIEWER_DIFFICULTIES.map((d) =>
          h(
            "button",
            {
              key: d.id,
              className: `difficulty-card ${settings.difficulty === d.id ? "selected" : ""}`,
              onClick: () => onChangeSettings({ difficulty: d.id }),
              "aria-pressed": settings.difficulty === d.id,
            },
            h("span", { className: "difficulty-name" }, d.label),
            h("span", { className: "difficulty-blurb" }, d.blurb)
          )
        )
      ),

      // --- Problem (rolled by the weighted randomizer) ---
      h("h2", { className: "field-label" }, "Your problem"),
      h(
        "div",
        { className: "problem-preview" },
        h(
          "div",
          { className: "problem-preview-text" },
          h("span", { className: "badge" }, problem.difficulty),
          h("span", { className: "problem-preview-title" }, problem.title)
        ),
        h("button", { className: "btn btn-randomize", onClick: onRandomize }, "🎲 Randomize")
      ),

      // --- Session length ---
      h("h2", { className: "field-label" }, "Length"),
      h(
        "div",
        { className: "length-toggle" },
        SESSION_LENGTHS.map((s) =>
          h(
            "button",
            {
              key: s.id,
              className: `length-btn ${settings.sessionLength === s.id ? "selected" : ""}`,
              onClick: () => onChangeSettings({ sessionLength: s.id }),
            },
            s.label
          )
        )
      ),

      h("button", { className: "btn btn-primary btn-start", onClick: onStart }, "Start interview →")
    )
  );
}
