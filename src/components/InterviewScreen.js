import { useState, useRef, useEffect, h } from "../reactRuntime.js";
import CodeEditor from "./CodeEditor.js";
import { resolvePersonaDescription } from "../config.js";
import { runAllTests } from "../utils/sandbox.js";
import { createVoiceRecorder } from "../utils/voiceRecorder.js";
import { blobToBase64, playBase64Audio } from "../utils/audio.js";
import { speechToText, textToSpeech } from "../api/speechClient.js";
import { callGeminiInterviewTurn } from "../api/geminiClient.js";

const IDLE_NUDGE_MS = 90000;

export default function InterviewScreen({
  currentProblem,
  settings,
  code,
  setCode,
  lastTestResults,
  setLastTestResults,
  transcript,
  setTranscript,
  interviewerImpressions,
  setInterviewerImpressions,
  hintsUsed,
  setHintsUsed,
  onWrapUp,
}) {
  const [micState, setMicState] = useState("idle"); // idle | listening | processing | speaking
  const [micAvailable, setMicAvailable] = useState(true);
  const [textInputValue, setTextInputValue] = useState("");
  const [runningTests, setRunningTests] = useState(false);
  const [errorBanner, setErrorBanner] = useState(null); // { message, retry }

  // Refs mirror fast-changing state so async callbacks (voice pipeline,
  // idle-nudge timer, retry closures) never read stale values.
  const codeRef = useRef(code);
  useEffect(() => { codeRef.current = code; }, [code]);
  const lastTestResultsRef = useRef(lastTestResults);
  useEffect(() => { lastTestResultsRef.current = lastTestResults; }, [lastTestResults]);
  const transcriptRef = useRef(transcript);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);

  const recorderRef = useRef(null);
  if (!recorderRef.current) recorderRef.current = createVoiceRecorder();

  const lastActivityRef = useRef(Date.now());
  const idleNudgeInFlightRef = useRef(false);

  // Sends one turn to Gemini, appends the interviewer's reply to the
  // transcript, and speaks it. Shared by all three triggers (voice, run
  // code, idle nudge) so persona + impressions stay consistent no matter
  // which one fired.
  async function runInterviewerTurn(latestEvent, candidateEntryText) {
    const transcriptSoFar = candidateEntryText
      ? [...transcriptRef.current, { role: "candidate", text: candidateEntryText }]
      : transcriptRef.current;
    if (candidateEntryText) {
      setTranscript(transcriptSoFar);
      transcriptRef.current = transcriptSoFar;
    }

    const personaDescription = resolvePersonaDescription(settings, currentProblem);
    let turn;
    try {
      turn = await callGeminiInterviewTurn({
        currentProblem,
        personaDescription,
        settings,
        code: codeRef.current,
        lastTestResults: lastTestResultsRef.current,
        transcript: transcriptSoFar,
        interviewerImpressions,
        latestEvent,
      });
    } catch (err) {
      setMicState("idle");
      setErrorBanner({
        message: `The interviewer didn't respond: ${err.message}`,
        retry: () => {
          setErrorBanner(null);
          setMicState("processing");
          runInterviewerTurn(latestEvent, null).catch(() => {});
        },
      });
      throw err;
    }

    const transcriptWithReply = [...transcriptSoFar, { role: "interviewer", text: turn.response }];
    setTranscript(transcriptWithReply);
    transcriptRef.current = transcriptWithReply;
    setInterviewerImpressions(turn.updatedImpressions);

    // Speak the reply. This is a soft-fail path on purpose: the text is
    // already in the transcript, so a TTS hiccup or blocked autoplay should
    // never strand the UI or block the conversation from continuing.
    setMicState("speaking");
    try {
      const audioB64 = await textToSpeech(turn.response);
      await playBase64Audio(audioB64);
    } catch (err) {
      console.warn("Text-to-Speech unavailable:", err.message);
    }
    setMicState("idle");
    return turn;
  }

  // "Latest ref" pattern: the idle-nudge timer below is set up once and
  // must never call a stale closure, so it always calls through this ref
  // instead of capturing `runInterviewerTurn` directly.
  const latestRunTurnRef = useRef(runInterviewerTurn);
  latestRunTurnRef.current = runInterviewerTurn;

  // ---------------------------------------------------------------------
  // TRIGGER 3 (stretch) — idle nudge. If ~90s pass with no code edits and
  // no voice input, proactively ask Gemini for an in-character hint.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const interval = setInterval(async () => {
      const idleFor = Date.now() - lastActivityRef.current;
      if (idleFor > IDLE_NUDGE_MS && micState === "idle" && !errorBanner && !idleNudgeInFlightRef.current) {
        idleNudgeInFlightRef.current = true;
        lastActivityRef.current = Date.now();
        setHintsUsed((h) => h + 1);
        setMicState("processing");
        try {
          await latestRunTurnRef.current("idle nudge requested", null);
        } catch {
          /* error banner already surfaced inside runInterviewerTurn */
        }
        idleNudgeInFlightRef.current = false;
      }
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line
  }, [micState, errorBanner]);

  // ---------------------------------------------------------------------
  // TRIGGER 1 — voice (push to talk)
  // ---------------------------------------------------------------------
  async function handleMicClick() {
    if (errorBanner || runningTests) return;

    if (micState === "idle") {
      try {
        await recorderRef.current.start();
        setMicState("listening");
        lastActivityRef.current = Date.now();
      } catch (err) {
        // Mic permission denied (or no mic) → fall back to typed input for
        // the rest of the session.
        setMicAvailable(false);
      }
      return;
    }

    if (micState === "listening") {
      setMicState("processing");
      let candidateText;
      try {
        const blob = await recorderRef.current.stop();
        const base64 = await blobToBase64(blob);
        candidateText = await speechToText(base64);
      } catch (err) {
        setMicState("idle");
        setErrorBanner({
          message: `Couldn't transcribe that: ${err.message}`,
          retry: () => setErrorBanner(null),
        });
        return;
      }
      lastActivityRef.current = Date.now();
      try {
        await runInterviewerTurn(`candidate said: "${candidateText}"`, candidateText);
      } catch {
        /* error banner already surfaced inside runInterviewerTurn */
      }
    }
  }

  async function handleSubmitText(e) {
    e.preventDefault();
    const text = textInputValue.trim();
    if (!text || errorBanner || runningTests) return;
    setTextInputValue("");
    lastActivityRef.current = Date.now();
    setMicState("processing");
    try {
      await runInterviewerTurn(`candidate said: "${text}"`, text);
    } catch {
      /* error banner already surfaced inside runInterviewerTurn */
    }
  }

  // ---------------------------------------------------------------------
  // TRIGGER 2 — Run code
  // ---------------------------------------------------------------------
  async function handleRunCode() {
    if (errorBanner || runningTests || micState !== "idle") return;
    setRunningTests(true);
    lastActivityRef.current = Date.now();
    const results = await runAllTests(codeRef.current, currentProblem.testCases);
    setLastTestResults(results);
    lastTestResultsRef.current = results;
    setRunningTests(false);

    setMicState("processing");
    try {
      await runInterviewerTurn("candidate just ran their code", null);
    } catch {
      /* error banner already surfaced inside runInterviewerTurn */
    }
  }

  const micLabel = {
    idle: "🎤 Click to speak",
    listening: "● Recording... click when done",
    processing: "Thinking...",
    speaking: "🔊 Interviewer speaking...",
  }[micState];

  return h(
    "div",
    { className: "screen interview-screen" },

    errorBanner &&
      h(
        "div",
        { className: "error-banner" },
        h("span", null, `⚠️ ${errorBanner.message}`),
        h("button", { className: "btn btn-small", onClick: errorBanner.retry }, "Retry"),
        h("button", { className: "btn btn-small btn-ghost", onClick: () => setErrorBanner(null) }, "Dismiss")
      ),

    h(
      "div",
      { className: "interview-layout" },

      h(
        "div",
        { className: "panel panel-left" },

        h(
          "div",
          { className: "problem-panel" },
          h(
            "div",
            { className: "problem-header" },
            h("h2", null, currentProblem.title),
            h("span", { className: "badge" }, currentProblem.difficulty)
          ),
          h("p", null, currentProblem.description)
        ),

        h(CodeEditor, {
          key: currentProblem.id,
          initialCode: code,
          onChange: (next) => {
            setCode(next);
            lastActivityRef.current = Date.now();
          },
        }),

        h(
          "div",
          { className: "run-panel" },
          h(
            "button",
            {
              className: "btn btn-primary",
              onClick: handleRunCode,
              disabled: runningTests || micState !== "idle" || !!errorBanner,
            },
            runningTests ? "Running..." : "Run code"
          ),
          h(
            "div",
            { className: "test-results" },
            lastTestResults.length === 0 && h("p", { className: "muted" }, "No runs yet."),
            lastTestResults.map((t, i) =>
              h(
                "div",
                { key: i, className: `test-result ${t.passed ? "pass" : "fail"}` },
                h("span", null, `${t.passed ? "✅" : "❌"} Test ${i + 1}`),
                h(
                  "span",
                  { className: "test-detail" },
                  `input: ${JSON.stringify(t.input)} → expected ${JSON.stringify(t.expected)}, got ${
                    t.error ? `error: ${t.error}` : JSON.stringify(t.actual)
                  }`
                )
              )
            )
          )
        )
      ),

      h(
        "div",
        { className: "panel panel-right" },

        h("button", { className: "btn btn-wrapup", onClick: onWrapUp }, "Wrap up interview"),

        h(
          "div",
          { className: "voice-control" },
          micAvailable
            ? h(
                "button",
                {
                  className: `mic-btn mic-${micState}`,
                  onClick: handleMicClick,
                  disabled: micState === "processing" || micState === "speaking" || !!errorBanner || runningTests,
                },
                micLabel
              )
            : h(
                "form",
                { className: "text-fallback", onSubmit: handleSubmitText },
                h("input", {
                  type: "text",
                  placeholder: "Mic unavailable — type to the interviewer instead",
                  value: textInputValue,
                  onChange: (e) => setTextInputValue(e.target.value),
                  disabled: micState !== "idle" || !!errorBanner,
                }),
                h(
                  "button",
                  { className: "btn btn-small", type: "submit", disabled: micState !== "idle" || !!errorBanner },
                  "Send"
                )
              )
        ),

        h(
          "div",
          { className: "transcript" },
          transcript.length === 0 &&
            h("p", { className: "muted" }, "The interviewer is waiting for you to begin."),
          transcript.map((entry, i) =>
            h(
              "div",
              { key: i, className: `transcript-entry role-${entry.role}` },
              h("span", { className: "role-label" }, entry.role === "interviewer" ? "Interviewer" : "You"),
              h("span", { className: "entry-text" }, entry.text)
            )
          )
        )
      )
    )
  );
}
