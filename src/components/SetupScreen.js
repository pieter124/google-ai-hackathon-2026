import { h } from "../reactRuntime.js";
import { DIFFICULTY_OPTIONS, PERSONA_OPTIONS } from "../config.js";

export default function SetupScreen({ settings, onChangeSettings, onStart }) {
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
        "Practice a live coding interview against an AI interviewer — voice, real editor, real test cases."
      ),
      h(
        "label",
        { className: "field" },
        h("span", null, "Difficulty"),
        h(
          "select",
          {
            value: settings.difficulty,
            onChange: (e) => onChangeSettings({ difficulty: e.target.value }),
          },
          DIFFICULTY_OPTIONS.map((opt) => h("option", { key: opt.id, value: opt.id }, opt.label))
        )
      ),
      h(
        "label",
        { className: "field" },
        h("span", null, "Interviewer persona"),
        h(
          "select",
          {
            value: settings.persona,
            onChange: (e) => onChangeSettings({ persona: e.target.value }),
          },
          PERSONA_OPTIONS.map((opt) => h("option", { key: opt.id, value: opt.id }, opt.label))
        )
      ),
      h(
        "button",
        { className: "btn btn-primary btn-start", onClick: onStart },
        "Start interview"
      )
    )
  );
}
