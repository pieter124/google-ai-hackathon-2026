import { useState, useRef, useEffect, h } from "../reactRuntime.js";
import CodeEditor from "./CodeEditor.js";
import Avatar from "./Avatar.js";
import { resolveInterviewer, WATCHDOG, AGGREGATOR_INTERVAL_MS } from "../config.js";
import { runAllTests } from "../utils/sandbox.js";
import { createVoiceRecorder } from "../utils/voiceRecorder.js";
import { blobToBase64, playBase64Audio } from "../utils/audio.js";
import { createSessionLog } from "../utils/sessionLog.js";
import { analyzeFillers, recentFillerRatio } from "../utils/fillerWords.js";
import { speechToText, textToSpeech } from "../api/speechClient.js";
import { callGeminiInterviewTurn, callGeminiCheckpoint } from "../api/geminiClient.js";

const FILLER_WINDOW_MS = 90000; // how far back the Watchdog reads speech for its filler check

function formatClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  const [caption, setCaption] = useState("Take a moment to read the problem, then click the mic and introduce your approach.");
  const [remainingMs, setRemainingMs] = useState(settings.sessionLength * 60000);

  // --- Refs that mirror fast-changing state so async callbacks (voice
  // pipeline, agent timers) never read stale values. ---
  const codeRef = useRef(code);
  useEffect(() => { codeRef.current = code; }, [code]);
  const lastTestResultsRef = useRef(lastTestResults);
  useEffect(() => { lastTestResultsRef.current = lastTestResults; }, [lastTestResults]);
  const transcriptRef = useRef(transcript);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
  const hintsUsedRef = useRef(hintsUsed);
  useEffect(() => { hintsUsedRef.current = hintsUsed; }, [hintsUsed]);
  const impressionsRef = useRef(interviewerImpressions);
  useEffect(() => { impressionsRef.current = interviewerImpressions; }, [interviewerImpressions]);

  // Volatile UI state the Watchdog reads on its own timer. Mirrored into refs
  // so the Watchdog interval can be created ONCE on mount — depending on these
  // in the effect array would tear down and recreate the 3s interval on every
  // change (and, for the per-second timer, mean it never fires at all).
  const micStateRef = useRef(micState);
  useEffect(() => { micStateRef.current = micState; }, [micState]);
  const errorBannerRef = useRef(errorBanner);
  useEffect(() => { errorBannerRef.current = errorBanner; }, [errorBanner]);
  const runningTestsRef = useRef(runningTests);
  useEffect(() => { runningTestsRef.current = runningTests; }, [runningTests]);
  const remainingMsRef = useRef(remainingMs);
  useEffect(() => { remainingMsRef.current = remainingMs; }, [remainingMs]);

  const recorderRef = useRef(null);
  if (!recorderRef.current) recorderRef.current = createVoiceRecorder();

  // Shared session log + amplitude channel for the avatar. Created once.
  const startRef = useRef(Date.now());
  const logRef = useRef(null);
  if (!logRef.current) logRef.current = createSessionLog(startRef.current);
  const amplitudeRef = useRef(0);

  // Watchdog / Aggregator bookkeeping (wall-clock for activity diffs).
  const lastActivityRef = useRef(Date.now()); // any candidate activity: mic, type, run
  const lastCodeChangeRef = useRef(Date.now()); // typing only
  const lastNudgeRef = useRef(0);
  const nudgeInFlightRef = useRef(false);
  const lastCheckpointTRef = useRef(0); // session-relative ms
  const charsAtCheckpointRef = useRef(code.length);
  const checkpointInFlightRef = useRef(false);
  const wrappedRef = useRef(false);

  const interviewer = resolveInterviewer(settings.difficulty);

  // -----------------------------------------------------------------------
  // Shared turn runner — used by voice, run-code, and the Watchdog nudge, so
  // persona/impressions/logging stay identical no matter which trigger fired.
  // -----------------------------------------------------------------------
  async function runInterviewerTurn(latestEvent, candidateEntryText, source = "turn") {
    const transcriptSoFar = candidateEntryText
      ? [...transcriptRef.current, { role: "candidate", text: candidateEntryText }]
      : transcriptRef.current;
    if (candidateEntryText) {
      setTranscript(transcriptSoFar);
      transcriptRef.current = transcriptSoFar;
      logRef.current.logTurn({ role: "candidate", text: candidateEntryText });
    }

    let turn;
    try {
      turn = await callGeminiInterviewTurn({
        currentProblem,
        personaDescription: interviewer.description,
        hintPosture: interviewer.hintPosture,
        difficulty: settings.difficulty,
        code: codeRef.current,
        lastTestResults: lastTestResultsRef.current,
        transcript: transcriptSoFar,
        interviewerImpressions: impressionsRef.current,
        latestEvent,
      });
    } catch (err) {
      setMicState("idle");
      setErrorBanner({
        message: `The interviewer didn't respond: ${err.message}`,
        retry: () => {
          setErrorBanner(null);
          setMicState("processing");
          runInterviewerTurn(latestEvent, null, source).catch(() => {});
        },
      });
      throw err;
    }

    const transcriptWithReply = [...transcriptSoFar, { role: "interviewer", text: turn.response }];
    setTranscript(transcriptWithReply);
    transcriptRef.current = transcriptWithReply;
    setInterviewerImpressions(turn.updatedImpressions);
    impressionsRef.current = turn.updatedImpressions;
    setCaption(turn.response);
    logRef.current.logTurn({ role: "interviewer", text: turn.response, progress: turn.progress, source });

    // Speak the reply — soft-fail: the text is already the caption, so a TTS
    // hiccup or blocked autoplay must never strand the UI.
    setMicState("speaking");
    try {
      const audioB64 = await textToSpeech(turn.response);
      await playBase64Audio(audioB64, (v) => { amplitudeRef.current = v; });
    } catch (err) {
      console.warn("Text-to-Speech unavailable:", err.message);
    }
    setMicState("idle");
    return turn;
  }

  // Latest-ref pattern: agent timers are set up once and must never call a
  // stale closure, so they call through these refs.
  const latestRunTurnRef = useRef(runInterviewerTurn);
  latestRunTurnRef.current = runInterviewerTurn;

  function markActivity({ typed = false } = {}) {
    lastActivityRef.current = Date.now();
    if (typed) lastCodeChangeRef.current = Date.now();
  }

  // -----------------------------------------------------------------------
  // Wrap-up — hands the derived signals up to App for the report. Guarded so
  // the timer and the manual button can't both fire it.
  // -----------------------------------------------------------------------
  function wrapUp() {
    if (wrappedRef.current) return;
    wrappedRef.current = true;
    const log = logRef.current;
    onWrapUp({
      hintsUsed: hintsUsedRef.current,
      progressSeries: log.progressSeries(),
      checkpointNotes: log.all().filter((e) => e.kind === "checkpoint").map((e) => e.note),
      fillerStats: analyzeFillers(log.candidateSpeechSince(-1)),
    });
  }
  const latestWrapUpRef = useRef(wrapUp);
  latestWrapUpRef.current = wrapUp;

  // -----------------------------------------------------------------------
  // Session timer — one interval, counts down, auto-wraps at zero.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const total = settings.sessionLength * 60000;
    const id = setInterval(() => {
      const left = total - (Date.now() - startRef.current);
      setRemainingMs(left);
      if (left <= 0) {
        clearInterval(id);
        latestWrapUpRef.current();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [settings.sessionLength]);

  // -----------------------------------------------------------------------
  // AGENT 2 — Aggregator. Independent timer; analyzes the window since the
  // last checkpoint and logs a progress signal + note. Best-effort: any error
  // is swallowed so it can never disturb the live loop.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(async () => {
      if (checkpointInFlightRef.current || wrappedRef.current) return;
      const log = logRef.current;
      const since = lastCheckpointTRef.current;
      const windowTranscript = log.candidateSpeechSince(since);
      const delta = codeRef.current.length - charsAtCheckpointRef.current;
      const keystrokeSummary =
        delta > 0 ? `added ~${delta} chars of code` : delta < 0 ? `removed ~${-delta} chars` : "no code changes";

      checkpointInFlightRef.current = true;
      try {
        const cp = await callGeminiCheckpoint({
          currentProblem,
          code: codeRef.current,
          windowTranscript,
          keystrokeSummary,
        });
        log.logCheckpoint(cp);
        lastCheckpointTRef.current = log.now();
        charsAtCheckpointRef.current = codeRef.current.length;
      } catch (err) {
        console.warn("Aggregator checkpoint skipped:", err.message);
      } finally {
        checkpointInFlightRef.current = false;
      }
    }, AGGREGATOR_INTERVAL_MS);
    return () => clearInterval(id);
    // currentProblem is stable for the life of the screen.
  }, [currentProblem]);

  // -----------------------------------------------------------------------
  // AGENT 3 — Watchdog. Fires on the fast cadence: snapshots keystrokes every
  // tick (the "3-second keystroke log"), then checks two research-backed stuck
  // patterns and nudges once past threshold, respecting a cooldown.
  //   A) silent + idle: no typing AND no turn for silentIdleMs.
  //   B) talking without progress: high filler ratio AND not coding.
  // -----------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const log = logRef.current;
      log.logKeystrokeSnapshot({ chars: codeRef.current.length });

      if (wrappedRef.current || nudgeInFlightRef.current || micStateRef.current !== "idle" || errorBannerRef.current || runningTestsRef.current) return;
      const now = Date.now();
      if (now - lastNudgeRef.current < WATCHDOG.minCooldownMs) return;
      if (remainingMsRef.current < 15000) return; // don't nudge in the last few seconds

      const silentIdle = now - lastActivityRef.current > WATCHDOG.silentIdleMs;
      const recentSpeech = log.candidateSpeechSince(log.now() - FILLER_WINDOW_MS);
      const notCoding = now - lastCodeChangeRef.current > WATCHDOG.silentIdleMs;
      const fillerNoProgress =
        recentSpeech.split(/\s+/).length >= 12 &&
        recentFillerRatio(recentSpeech) > WATCHDOG.fillerRatioThreshold &&
        notCoding;

      if (!silentIdle && !fillerNoProgress) return;

      const reason = silentIdle ? "candidate is silent and idle (no typing, no turn)" : "candidate is talking with lots of filler but not making progress";
      nudgeInFlightRef.current = true;
      lastNudgeRef.current = now;
      log.logNudge({ reason, text: "" });
      setHintsUsed((n) => n + 1);
      setMicState("processing");
      latestRunTurnRef.current(`proactive nudge — ${reason}`, null, "nudge")
        .catch(() => {})
        .finally(() => { nudgeInFlightRef.current = false; });
    }, WATCHDOG.checkEveryMs);
    return () => clearInterval(id);
    // Mount once; all volatile reads go through refs above.
  }, []);

  // -----------------------------------------------------------------------
  // TRIGGER 1 — voice (push to talk)
  // -----------------------------------------------------------------------
  async function handleMicClick() {
    if (errorBanner || runningTests) return;

    if (micState === "idle") {
      try {
        await recorderRef.current.start();
        setMicState("listening");
        markActivity();
      } catch {
        setMicAvailable(false); // no mic / denied → fall back to typed input
      }
      return;
    }

    if (micState === "listening") {
      setMicState("processing");
      let candidateText;
      try {
        const blob = await recorderRef.current.stop();
        const base64 = await blobToBase64(blob);
        candidateText = await speechToText(base64, blob.type);
      } catch (err) {
        setMicState("idle");
        setErrorBanner({ message: `Couldn't transcribe that: ${err.message}`, retry: () => setErrorBanner(null) });
        return;
      }
      markActivity();
      try {
        await runInterviewerTurn(`candidate said: "${candidateText}"`, candidateText);
      } catch { /* banner already surfaced */ }
    }
  }

  async function handleSubmitText(e) {
    e.preventDefault();
    const text = textInputValue.trim();
    if (!text || errorBanner || runningTests) return;
    setTextInputValue("");
    markActivity();
    setMicState("processing");
    try {
      await runInterviewerTurn(`candidate said: "${text}"`, text);
    } catch { /* banner already surfaced */ }
  }

  // -----------------------------------------------------------------------
  // TRIGGER 2 — run code
  // -----------------------------------------------------------------------
  async function handleRunCode() {
    if (errorBanner || runningTests || micState !== "idle") return;
    setRunningTests(true);
    markActivity();
    const results = await runAllTests(codeRef.current, currentProblem.testCases);
    setLastTestResults(results);
    lastTestResultsRef.current = results;
    logRef.current.logRun({ passed: results.filter((r) => r.passed).length, total: results.length });
    setRunningTests(false);

    setMicState("processing");
    try {
      await runInterviewerTurn("candidate just ran their code", null);
    } catch { /* banner already surfaced */ }
  }

  const micLabel = {
    idle: "🎤 Click to speak",
    listening: "● Recording… click when done",
    processing: "Thinking…",
    speaking: "🔊 Interviewer speaking…",
  }[micState];

  const lowTime = remainingMs < 120000;

  return h(
    "div",
    { className: "screen interview-screen" },

    h(Avatar, { state: micState, amplitudeRef, caption }),

    errorBanner &&
      h(
        "div",
        { className: "error-banner" },
        h("span", null, `⚠️ ${errorBanner.message}`),
        h("button", { className: "btn btn-small", onClick: errorBanner.retry }, "Retry"),
        h("button", { className: "btn btn-small btn-ghost", onClick: () => setErrorBanner(null) }, "Dismiss")
      ),

    // --- Header: problem identity (left) + timer & wrap-up (right) ---
    h(
      "div",
      { className: "interview-header" },
      h(
        "div",
        { className: "problem-header" },
        h("h2", null, currentProblem.title),
        h("span", { className: "badge" }, currentProblem.difficulty)
      ),
      h(
        "div",
        { className: "header-right" },
        h("span", { className: `session-timer ${lowTime ? "low" : ""}` }, formatClock(remainingMs)),
        h("button", { className: "btn btn-wrapup", onClick: wrapUp }, "Wrap up")
      )
    ),

    // --- Problem statement (top) ---
    h("div", { className: "problem-panel" }, h("p", null, currentProblem.description)),

    // --- Code editor (fills the middle) ---
    h(CodeEditor, {
      key: currentProblem.id,
      initialCode: code,
      onChange: (next) => {
        setCode(next);
        markActivity({ typed: true });
      },
    }),

    // --- Run bar + results ---
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
        runningTests ? "Running…" : "Run code"
      ),
      h(
        "div",
        { className: "test-results" },
        lastTestResults.length === 0 && h("span", { className: "muted" }, "No runs yet."),
        lastTestResults.map((t, i) =>
          h(
            "span",
            { key: i, className: `test-chip ${t.passed ? "pass" : "fail"}`, title: `input: ${JSON.stringify(t.input)} → expected ${JSON.stringify(t.expected)}, got ${t.error ? `error: ${t.error}` : JSON.stringify(t.actual)}` },
            `${t.passed ? "✅" : "❌"} ${i + 1}`
          )
        )
      )
    ),

    // --- Voice control (bottom) ---
    h(
      "div",
      { className: "voice-bar" },
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
            h("button", { className: "btn btn-small", type: "submit", disabled: micState !== "idle" || !!errorBanner }, "Send")
          )
    )
  );
}
