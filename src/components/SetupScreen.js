import { useState, useEffect, h } from "../reactRuntime.js";
import { INTERVIEWERS, LANGUAGE_OPTIONS, SESSION_LENGTH_OPTIONS } from "../config.js";
import { getAvatar } from "../api/avatarClient.js";
import { unlockAudioContext } from "../utils/audio.js";

function initialsOf(name) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Simple segmented control shared by the language and session-length dials.
function Segmented({ options, value, onChange, ariaLabel }) {
  return h(
    "div",
    { className: "segmented", role: "group", "aria-label": ariaLabel },
    options.map((opt) =>
      h(
        "button",
        {
          key: opt.id,
          type: "button",
          className: `segmented-option${opt.id === value ? " selected" : ""}`,
          onClick: () => onChange(opt.id),
        },
        opt.label
      )
    )
  );
}

// The problem is picked by the weighted randomizer (~10% easy / ~45% medium /
// ~45% hard) once the candidate hits Start — the dials here are who
// interviews you, which language you code in, and how long you get.
export default function SetupScreen({ settings, onChangeSettings, onStart }) {
  // id -> data URI once generated; id -> "error" locks in the initials
  // fallback. Absent while the shimmer placeholder shows.
  const [avatars, setAvatars] = useState({});

  useEffect(() => {
    let cancelled = false;
    for (const interviewer of INTERVIEWERS) {
      getAvatar(interviewer)
        .then((dataUri) => {
          if (!cancelled) setAvatars((prev) => ({ ...prev, [interviewer.id]: dataUri }));
        })
        .catch(() => {
          if (!cancelled) setAvatars((prev) => ({ ...prev, [interviewer.id]: "error" }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

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
        "A live coding interview against an AI interviewer — real voice, real editor, real test cases. Pick who's across the table; the problem is chosen for you, weighted toward medium and hard."
      ),

      h("h2", { className: "setup-section-title" }, "Your interviewer"),
      h(
        "div",
        { className: "interviewer-grid" },
        INTERVIEWERS.map((interviewer) => {
          const avatar = avatars[interviewer.id];
          const selected = settings.interviewerId === interviewer.id;
          return h(
            "button",
            {
              key: interviewer.id,
              type: "button",
              className: `interviewer-card${selected ? " selected" : ""}`,
              onClick: () => onChangeSettings({ interviewerId: interviewer.id }),
              "aria-pressed": selected,
            },
            avatar && avatar !== "error"
              ? h("img", { className: "interviewer-avatar", src: avatar, alt: "" })
              : h(
                  "div",
                  { className: `interviewer-avatar avatar-fallback${avatar ? "" : " shimmer"}` },
                  initialsOf(interviewer.name)
                ),
            h(
              "div",
              { className: "interviewer-meta" },
              h("span", { className: "interviewer-name" }, interviewer.name),
              h("span", { className: "interviewer-title" }, interviewer.title),
              h("span", { className: "interviewer-blurb" }, interviewer.blurb)
            )
          );
        })
      ),

      h(
        "div",
        { className: "setup-dials" },
        h(
          "div",
          { className: "field" },
          h("span", null, "Language"),
          h(Segmented, {
            options: LANGUAGE_OPTIONS,
            value: settings.language,
            onChange: (language) => onChangeSettings({ language }),
            ariaLabel: "Coding language",
          })
        ),
        h(
          "div",
          { className: "field" },
          h("span", null, "Session length"),
          h(Segmented, {
            options: SESSION_LENGTH_OPTIONS,
            value: settings.sessionLengthMinutes,
            onChange: (sessionLengthMinutes) => onChangeSettings({ sessionLengthMinutes }),
            ariaLabel: "Session length",
          })
        )
      ),

      h(
        "button",
        {
          className: "btn btn-primary btn-start",
          // unlockAudioContext must run synchronously inside this click so
          // the browser credits the whole session's audio graph (greeting
          // TTS included) as gesture-driven — see utils/audio.js.
          onClick: () => {
            unlockAudioContext();
            onStart();
          },
        },
        "Start interview"
      ),
      h(
        "p",
        { className: "setup-mic-note" },
        "🎙 The interview is hands-free: allow microphone access when prompted, then just talk. You can also type at any time."
      )
    )
  );
}
