import { useState, useEffect, h } from "../reactRuntime.js";
import { INTERVIEWERS, LANGUAGE_OPTIONS, SESSION_LENGTH_OPTIONS } from "../config.js";
import { getAvatar, getAvatarVariant } from "../api/avatarClient.js";
import { preloadPython } from "../utils/pythonRunner.js";
import { unlockAudioContext } from "../utils/audio.js";

function initialsOf(name) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Segmented control shared by the language and session-length dials.
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

// The problem is picked for the candidate at Start; the dials here choose the
// interviewer, language, and session length.
export default function SetupScreen({ settings, onChangeSettings, onStart }) {
  // id -> data URI once generated; id -> "error" for the initials fallback.
  // Absent while the shimmer placeholder shows.
  const [avatars, setAvatars] = useState({});

  useEffect(() => {
    let cancelled = false;
    const basePromises = INTERVIEWERS.map((interviewer) =>
      getAvatar(interviewer)
        .then((dataUri) => {
          if (!cancelled) setAvatars((prev) => ({ ...prev, [interviewer.id]: dataUri }));
        })
        .catch(() => {
          if (!cancelled) setAvatars((prev) => ({ ...prev, [interviewer.id]: "error" }));
        })
    );

    // Once the visible portraits are in, pre-generate every character's
    // animation frames one at a time so any interview started later has its
    // talking animation cached and ready. Not cancelled on unmount by design.
    Promise.allSettled(basePromises).then(async () => {
      for (const interviewer of INTERVIEWERS) {
        await getAvatarVariant(interviewer, "talking").catch(() => {});
        await getAvatarVariant(interviewer, "blink").catch(() => {});
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Picking Python here starts the ~10MB Pyodide download early, so the runtime
  // is warm before the editor appears. The worker singleton survives the switch.
  useEffect(() => {
    if (settings.language === "python") preloadPython();
  }, [settings.language]);

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
        "A live coding interview against an AI interviewer — real voice, real editor, real test cases. Pick who's across the table; the problem is chosen for you."
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
          // Must run synchronously in the click so the browser credits the
          // session's audio (greeting TTS included) as gesture-driven.
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
