import { h } from "../reactRuntime.js";
import { PERSONA_OPTIONS, SESSION_LENGTH_OPTIONS } from "../config.js";

// Difficulty is no longer chosen here — the problem is picked by the
// weighted randomizer (~10% easy / ~45% medium / ~45% hard) once the
// candidate hits Start. The only dials left are persona and session length.
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
        "Practice a live coding interview against an AI interviewer — voice, real editor, real test cases. Your problem is picked for you (weighted toward medium/hard)."
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
        "label",
        { className: "field" },
        h("span", null, "Session length"),
        h(
          "select",
          {
            value: settings.sessionLengthMinutes,
            onChange: (e) => onChangeSettings({ sessionLengthMinutes: Number(e.target.value) }),
          },
          SESSION_LENGTH_OPTIONS.map((opt) => h("option", { key: opt.id, value: opt.id }, opt.label))
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
