import { h } from "../reactRuntime.js";
import { INTERVIEWERS, LANGUAGE_OPTIONS, SESSION_LENGTHS, IS_API_KEY_SET } from "../config.js";

// First screen: pick your interviewer, language, roll a problem (medium+),
// pick a length, go. The problem is shown before starting so the candidate can
// reroll — the blue "Randomize" button is the primary action here.
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

      // --- Interviewer (persona + voice) ---
      h("h2", { className: "field-label" }, "Choose your interviewer"),
      h(
        "div",
        { className: "interviewer-cards" },
        INTERVIEWERS.map((p) =>
          h(
            "button",
            {
              key: p.id,
              className: `interviewer-card ${settings.interviewerId === p.id ? "selected" : ""}`,
              onClick: () => onChangeSettings({ interviewerId: p.id }),
              "aria-pressed": settings.interviewerId === p.id,
            },
            h("span", { className: "interviewer-avatar" }, initials(p.name)),
            h(
              "span",
              { className: "interviewer-text" },
              h("span", { className: "interviewer-name" }, p.name),
              h("span", { className: "interviewer-title" }, p.title),
              h("span", { className: "interviewer-blurb" }, p.blurb)
            )
          )
        )
      ),

      // --- Language + length (one row) ---
      h(
        "div",
        { className: "setup-inline" },
        h(
          "div",
          { className: "setup-inline-col" },
          h("h2", { className: "field-label" }, "Language"),
          h(
            "div",
            { className: "seg-toggle" },
            LANGUAGE_OPTIONS.map((l) =>
              h(
                "button",
                {
                  key: l.id,
                  className: `seg-btn ${settings.language === l.id ? "selected" : ""}`,
                  onClick: () => onChangeSettings({ language: l.id }),
                },
                l.label
              )
            )
          )
        ),
        h(
          "div",
          { className: "setup-inline-col" },
          h("h2", { className: "field-label" }, "Length"),
          h(
            "div",
            { className: "seg-toggle" },
            SESSION_LENGTHS.map((s) =>
              h(
                "button",
                {
                  key: s.id,
                  className: `seg-btn ${settings.sessionLength === s.id ? "selected" : ""}`,
                  onClick: () => onChangeSettings({ sessionLength: s.id }),
                },
                s.label
              )
            )
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

      h("button", { className: "btn btn-primary btn-start", onClick: onStart }, "Start interview →")
    )
  );
}

function initials(name) {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
