import { useState, useRef, useEffect, useMemo, h } from "../reactRuntime.js";
import CodeEditor from "./CodeEditor.js";
import AvatarOrb from "./AvatarOrb.js";
import CriteriaMatrix from "./CriteriaMatrix.js";
import { getPersonaDescription } from "../config.js";
import { runAllTests } from "../utils/sandbox.js";
import { createVoiceRecorder } from "../utils/voiceRecorder.js";
import { blobToBase64, prepareAudioPlayback, unlockAudioContext } from "../utils/audio.js";
import { aggregateFillerStats } from "../utils/fillerWords.js";
import { mergeCriteriaLog } from "../utils/criteria.js";
import { speechToText, textToSpeech } from "../api/speechClient.js";
import { callGeminiInterviewTurn, callGeminiCheckpoint, GeminiHttpError } from "../api/geminiClient.js";

// Tunable constants — named here rather than buried in logic so they're easy
// to shorten for a demo/test run without hunting through the file.
const WATCHDOG_CHECK_INTERVAL_MS = 5000;
// Push-to-talk has built-in click friction a continuous stream doesn't, so
// this is a UI-adapted number (tens of seconds), not the ~10s figure cited
// for continuous conversation.
const WATCHDOG_SILENT_IDLE_THRESHOLD_MS = 45000;
const WATCHDOG_FILLER_RATIO_THRESHOLD = 0.18;
const WATCHDOG_FILLER_LOOKBACK_TURNS = 3;
const AGGREGATOR_INTERVAL_MS = 4 * 60 * 1000;

function formatCountdown(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function InterviewScreen({
  currentProblem,
  settings,
  code,
  setCode,
  lastTestResults,
  setLastTestResults,
  transcript,
  setTranscript,
  criteriaLog,
  setCriteriaLog,
  watchdogNudgeCount,
  setWatchdogNudgeCount,
  onWrapUp,
}) {
  const [micState, setMicState] = useState("idle"); // idle | listening | processing | speaking
  const [micAvailable, setMicAvailable] = useState(true);
  const [textInputValue, setTextInputValue] = useState("");
  const [runningTests, setRunningTests] = useState(false);
  const [errorBanner, setErrorBanner] = useState(null); // { message, retry }
  const [activeAnalyser, setActiveAnalyser] = useState(null); // feeds the avatar orb
  const [secondsLeft, setSecondsLeft] = useState(settings.sessionLengthMinutes * 60);

  // Refs mirror fast-changing state so async callbacks (voice pipeline,
  // Watchdog/Aggregator timers, retry closures) never read stale values.
  const codeRef = useRef(code);
  useEffect(() => { codeRef.current = code; }, [code]);
  const lastTestResultsRef = useRef(lastTestResults);
  useEffect(() => { lastTestResultsRef.current = lastTestResults; }, [lastTestResults]);
  const transcriptRef = useRef(transcript);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  const criteriaLogRef = useRef(criteriaLog);
  useEffect(() => { criteriaLogRef.current = criteriaLog; }, [criteriaLog]);

  const recorderRef = useRef(null);
  if (!recorderRef.current) recorderRef.current = createVoiceRecorder();

  // Split (unlike the old single "any activity" timestamp) so the Watchdog
  // can check "no typing AND no turn sent" as a genuine dual condition.
  const lastCodeChangeAtRef = useRef(Date.now());
  const lastTurnSentAtRef = useRef(Date.now());
  const watchdogNudgeInFlightRef = useRef(false);

  const sessionStartRef = useRef(Date.now());
  const wrappedUpRef = useRef(false);
  const onWrapUpRef = useRef(onWrapUp);
  onWrapUpRef.current = onWrapUp;

  const liveCriteria = useMemo(() => mergeCriteriaLog(criteriaLog), [criteriaLog]);

  // Sends one turn to Gemini, appends the interviewer's reply to the
  // transcript + criteriaLog, and speaks it via Cloud Text-to-Speech. Shared
  // by every trigger (voice, run code, Watchdog nudges) so persona and the
  // running criteria stay consistent no matter which one fired. Throws on
  // Gemini failure — callers decide how to react (retry banner vs soft-fail)
  // since that differs per trigger.
  async function runInterviewerTurn({ latestEvent, candidateEntryText, audio }) {
    const transcriptSoFar = candidateEntryText
      ? [...transcriptRef.current, { role: "candidate", text: candidateEntryText }]
      : transcriptRef.current;
    if (candidateEntryText) {
      setTranscript(transcriptSoFar);
      transcriptRef.current = transcriptSoFar;
    }

    const personaDescription = getPersonaDescription(settings.persona);
    const turn = await callGeminiInterviewTurn({
      currentProblem,
      personaDescription,
      code: codeRef.current,
      lastTestResults: lastTestResultsRef.current,
      transcript: transcriptSoFar,
      criteriaLog: criteriaLogRef.current,
      latestEvent,
      audio,
    });

    const transcriptWithReply = [...transcriptSoFar, { role: "interviewer", text: turn.response }];
    setTranscript(transcriptWithReply);
    transcriptRef.current = transcriptWithReply;

    if (Object.keys(turn.criteriaUpdate).length > 0) {
      const entry = { timestamp: Date.now(), source: "turn", criteriaUpdate: turn.criteriaUpdate };
      const nextLog = [...criteriaLogRef.current, entry];
      setCriteriaLog(nextLog);
      criteriaLogRef.current = nextLog;
    }
    lastTurnSentAtRef.current = Date.now();

    // Speak the reply via Cloud Text-to-Speech — soft-fail on purpose: the
    // text is already in the transcript, so an audio hiccup never blocks
    // the conversation from continuing.
    setMicState("speaking");
    try {
      const base64Audio = await textToSpeech(turn.response);
      const { analyser, finished } = prepareAudioPlayback(base64Audio, "audio/mp3");
      setActiveAnalyser(analyser);
      await finished;
    } catch (err) {
      console.warn("Text-to-Speech unavailable:", err.message);
    }
    setActiveAnalyser(null);
    setMicState("idle");
    return turn;
  }

  // ---------------------------------------------------------------------
  // Session countdown — auto-wraps-up at zero, reusing the same flow as
  // the manual "Wrap up interview" button.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const interval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - sessionStartRef.current) / 1000);
      const remaining = Math.max(0, settings.sessionLengthMinutes * 60 - elapsedSec);
      setSecondsLeft(remaining);
      if (remaining <= 0 && !wrappedUpRef.current) {
        wrappedUpRef.current = true;
        onWrapUpRef.current();
      }
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line
  }, []);

  // ---------------------------------------------------------------------
  // AGENT 3 — Watchdog. Continuous background monitoring: keystroke
  // activity, time since the last turn, and the filler-word ratio of
  // recent candidate turns. Fires a proactive nudge (no click needed) when
  // either condition is sustained past its threshold.
  // ---------------------------------------------------------------------
  const latestRunTurnRef = useRef(runInterviewerTurn);
  latestRunTurnRef.current = runInterviewerTurn;
  const micStateRef = useRef(micState);
  useEffect(() => { micStateRef.current = micState; }, [micState]);
  const errorBannerRef = useRef(errorBanner);
  useEffect(() => { errorBannerRef.current = errorBanner; }, [errorBanner]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (micStateRef.current !== "idle" || errorBannerRef.current || watchdogNudgeInFlightRef.current) return;

      const now = Date.now();
      const silentAndIdle =
        now - lastCodeChangeAtRef.current > WATCHDOG_SILENT_IDLE_THRESHOLD_MS &&
        now - lastTurnSentAtRef.current > WATCHDOG_SILENT_IDLE_THRESHOLD_MS;

      const recentCandidateTexts = transcriptRef.current
        .filter((e) => e.role === "candidate")
        .slice(-WATCHDOG_FILLER_LOOKBACK_TURNS)
        .map((e) => e.text);
      const fillerRatio = recentCandidateTexts.length > 0 ? aggregateFillerStats(recentCandidateTexts).ratio : 0;
      const fillerWithoutProgress =
        recentCandidateTexts.length >= 2 &&
        fillerRatio > WATCHDOG_FILLER_RATIO_THRESHOLD &&
        now - lastCodeChangeAtRef.current > WATCHDOG_SILENT_IDLE_THRESHOLD_MS;

      if (!silentAndIdle && !fillerWithoutProgress) return;

      watchdogNudgeInFlightRef.current = true;
      lastTurnSentAtRef.current = now; // avoid immediately re-firing next tick
      setWatchdogNudgeCount((n) => n + 1);
      setMicState("processing");
      const reason = fillerWithoutProgress
        ? "watchdog: high filler-word ratio with little new code across recent turns — candidate may be talking without making progress"
        : "watchdog: candidate has been silent and not typing for a while — may be stuck";
      try {
        await latestRunTurnRef.current({ latestEvent: reason, candidateEntryText: null, audio: null });
      } catch (err) {
        // Soft-fail: a missed proactive nudge isn't worth a blocking banner
        // for something the candidate didn't ask for.
        console.warn("Watchdog nudge failed:", err.message);
        setMicState("idle");
      }
      watchdogNudgeInFlightRef.current = false;
    }, WATCHDOG_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // ---------------------------------------------------------------------
  // AGENT 2 — Aggregator. Fires on its own timer, independent of turns,
  // and analyzes the whole window since the last checkpoint (including
  // stretches where no turn was sent at all) so long idle windows and
  // slow drift still get logged, not silently skipped.
  // ---------------------------------------------------------------------
  const checkpointInFlightRef = useRef(false);
  const transcriptAtLastCheckpointRef = useRef([]);
  const codeAtLastCheckpointRef = useRef(code);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (checkpointInFlightRef.current) return;
      checkpointInFlightRef.current = true;

      const transcriptSlice = transcriptRef.current.slice(transcriptAtLastCheckpointRef.current.length);
      const codeChangeSummary =
        codeRef.current === codeAtLastCheckpointRef.current
          ? "No code changes since the last checkpoint."
          : "The candidate edited their code since the last checkpoint.";

      try {
        const { criteriaUpdate } = await callGeminiCheckpoint({
          currentProblem,
          code: codeRef.current,
          transcriptSlice,
          codeChangeSummary,
          criteriaLog: criteriaLogRef.current,
        });
        if (Object.keys(criteriaUpdate).length > 0) {
          const entry = { timestamp: Date.now(), source: "checkpoint", criteriaUpdate };
          const nextLog = [...criteriaLogRef.current, entry];
          setCriteriaLog(nextLog);
          criteriaLogRef.current = nextLog;
        }
      } catch (err) {
        console.warn("Checkpoint (Aggregator) failed:", err.message);
      }

      transcriptAtLastCheckpointRef.current = transcriptRef.current;
      codeAtLastCheckpointRef.current = codeRef.current;
      checkpointInFlightRef.current = false;
    }, AGGREGATOR_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line
  }, []);

  // ---------------------------------------------------------------------
  // TRIGGER 1 — voice (push to talk)
  // ---------------------------------------------------------------------
  async function handleMicClick() {
    if (errorBanner || runningTests) return;
    // Must happen synchronously inside this click handler (not after any
    // awaits) so the browser still credits it as a user gesture — see the
    // comment on unlockAudioContext in utils/audio.js.
    unlockAudioContext();

    if (micState === "idle") {
      try {
        await recorderRef.current.start();
        setMicState("listening");
      } catch (err) {
        // Mic permission denied (or no mic) → fall back to typed input for
        // the rest of the session.
        setMicAvailable(false);
      }
      return;
    }

    if (micState !== "listening") return;
    setMicState("processing");

    let blob;
    try {
      blob = await recorderRef.current.stop();
    } catch (err) {
      setMicState("idle");
      setErrorBanner({ message: `Recording failed: ${err.message}`, retry: () => setErrorBanner(null) });
      return;
    }

    let base64;
    try {
      base64 = await blobToBase64(blob);
    } catch (err) {
      setMicState("idle");
      setErrorBanner({ message: err.message, retry: () => setErrorBanner(null) });
      return;
    }
    const mimeType = blob.type || "audio/webm";

    // Attempt 1: native audio-in, per the spec — richer than transcribed
    // text alone (tone/hesitation/fluency). May 400 since Gemini's
    // documented input formats don't include webm/opus.
    try {
      await runInterviewerTurn({
        latestEvent: "candidate spoke (raw audio attached)",
        candidateEntryText: null,
        audio: { base64, mimeType },
      });
      return;
    } catch (err) {
      if (!(err instanceof GeminiHttpError) || err.status !== 400) {
        setMicState("idle");
        setErrorBanner({
          message: `The interviewer didn't respond: ${err.message}`,
          retry: () => {
            setErrorBanner(null);
            setMicState("processing");
            runInterviewerTurn({
              latestEvent: "candidate spoke (raw audio attached)",
              candidateEntryText: null,
              audio: { base64, mimeType },
            }).catch(() => setMicState("idle"));
          },
        });
        return;
      }
      // 400 → fall through to the Speech-to-Text fallback below.
    }

    // Attempt 2: Speech-to-Text fallback.
    let candidateText;
    try {
      candidateText = await speechToText(base64);
    } catch (sttErr) {
      setMicState("idle");
      setErrorBanner({ message: `Couldn't transcribe that: ${sttErr.message}`, retry: () => setErrorBanner(null) });
      return;
    }

    try {
      await runInterviewerTurn({ latestEvent: `candidate said: "${candidateText}"`, candidateEntryText: candidateText, audio: null });
    } catch (err) {
      setMicState("idle");
      setErrorBanner({
        message: `The interviewer didn't respond: ${err.message}`,
        retry: () => {
          setErrorBanner(null);
          setMicState("processing");
          runInterviewerTurn({ latestEvent: `candidate said: "${candidateText}"`, candidateEntryText: null, audio: null }).catch(() =>
            setMicState("idle")
          );
        },
      });
    }
  }

  async function handleSubmitText(e) {
    e.preventDefault();
    const text = textInputValue.trim();
    if (!text || errorBanner || runningTests) return;
    setTextInputValue("");
    setMicState("processing");
    try {
      await runInterviewerTurn({ latestEvent: `candidate said: "${text}"`, candidateEntryText: text, audio: null });
    } catch (err) {
      setMicState("idle");
      setErrorBanner({
        message: `The interviewer didn't respond: ${err.message}`,
        retry: () => {
          setErrorBanner(null);
          setMicState("processing");
          runInterviewerTurn({ latestEvent: `candidate said: "${text}"`, candidateEntryText: null, audio: null }).catch(() =>
            setMicState("idle")
          );
        },
      });
    }
  }

  // ---------------------------------------------------------------------
  // TRIGGER 2 — Run code
  // ---------------------------------------------------------------------
  async function handleRunCode() {
    if (errorBanner || runningTests || micState !== "idle") return;
    setRunningTests(true);
    const results = await runAllTests(codeRef.current, currentProblem.testCases);
    setLastTestResults(results);
    lastTestResultsRef.current = results;
    setRunningTests(false);

    setMicState("processing");
    try {
      await runInterviewerTurn({ latestEvent: "candidate just ran their code", candidateEntryText: null, audio: null });
    } catch (err) {
      setMicState("idle");
      setErrorBanner({
        message: `The interviewer didn't respond: ${err.message}`,
        retry: () => {
          setErrorBanner(null);
          setMicState("processing");
          runInterviewerTurn({ latestEvent: "candidate just ran their code", candidateEntryText: null, audio: null }).catch(() =>
            setMicState("idle")
          );
        },
      });
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
            lastCodeChangeAtRef.current = Date.now();
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

        h(
          "div",
          { className: "panel-right-header" },
          h(AvatarOrb, { analyser: activeAnalyser, active: micState === "speaking" }),
          h("div", { className: "session-countdown" }, formatCountdown(secondsLeft)),
          h("button", { className: "btn btn-wrapup", onClick: onWrapUp }, "Wrap up interview")
        ),

        h(CriteriaMatrix, { liveCriteria }),

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
