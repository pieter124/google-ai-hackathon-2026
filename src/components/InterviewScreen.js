import { useState, useRef, useEffect, h } from "../reactRuntime.js";
import CodeEditor from "./CodeEditor.js";
import Avatar from "./Avatar.js";
import CriteriaMatrix from "./CriteriaMatrix.js";
import { resolveInterviewer, WATCHDOG, AGGREGATOR_INTERVAL_MS } from "../config.js";
import { runAllTests } from "../utils/sandbox.js";
import { createVoiceRecorder } from "../utils/voiceRecorder.js";
import { blobToBase64, playBase64Audio } from "../utils/audio.js";
import { createSessionLog } from "../utils/sessionLog.js";
import { analyzeFillers, recentFillerRatio } from "../utils/fillerWords.js";
import { preloadPython, getPythonStatus, onPythonStatusChange } from "../utils/pythonRunner.js";
import { speechToText, textToSpeech } from "../api/speechClient.js";
import { callGeminiInterviewTurn, callGeminiCheckpoint } from "../api/geminiClient.js";

const FILLER_WINDOW_MS = 90000; // how far back the Watchdog reads speech for its filler check
const READING_MS = 180000; // 3-minute "read the problem" phase at the start
const APPROACH_SILENCE_MS = 13000; // after the candidate explains their approach, wait this long then ask them to code

// Scripted phase-transition directives sent to the interviewer as `latestEvent`
// so the model phrases them in its own persona/voice. Mirrors a real interview:
// read → explain approach → implement → (get unstuck).
const PHASE_EVENTS = {
  opening:
    "The interview is just starting. Greet the candidate briefly in character, then tell them they have 3 minutes to read the problem and its constraints and to ask any clarifying questions. Do NOT discuss the solution yet.",
  approach:
    "The 3-minute reading time is up. Ask the candidate to walk you through their approach — how they'd implement this — BEFORE writing any code. If they haven't asked a clarifying question, gently invite one.",
  implement:
    "The candidate has explained their approach. Briefly acknowledge it, then ask them to go ahead and start implementing it in code now.",
};

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
  hintsUsed,
  setHintsUsed,
  onWrapUp,
}) {
  const [micState, setMicState] = useState("idle"); // idle | listening | processing | speaking
  const [micAvailable, setMicAvailable] = useState(true);
  const [micMuted, setMicMuted] = useState(false); // user mutes their own input
  const [agentPaused, setAgentPaused] = useState(false); // interviewer speech paused
  const [hasSpoken, setHasSpoken] = useState(false); // enables "replay last line" once there is one
  const [textInputValue, setTextInputValue] = useState("");
  const [runningTests, setRunningTests] = useState(false);
  const [errorBanner, setErrorBanner] = useState(null); // { message, retry }
  const [caption, setCaption] = useState("Tip: asking clarifying questions early is a strong signal in interviews.");
  const [remainingMs, setRemainingMs] = useState(settings.sessionLength * 60000);
  // Interview phase: reading (3-min timer) → approach (explain out loud) →
  // implementing (code, with stuck-detection). Drives what the agents do.
  const [phase, setPhase] = useState("reading");
  const [phaseMsLeft, setPhaseMsLeft] = useState(READING_MS);
  // Live, on-screen rubric scores — merged last-write-wins from every turn's
  // and checkpoint's criteriaUpdate. `liveCriteriaRef` mirrors it so the
  // agent calls can pass current scores as prompt context without re-render.
  const [liveCriteria, setLiveCriteria] = useState({});
  const liveCriteriaRef = useRef({});
  function mergeCriteria(update) {
    if (!update || !Object.keys(update).length) return;
    setLiveCriteria((prev) => {
      const next = { ...prev, ...update };
      liveCriteriaRef.current = next;
      return next;
    });
  }

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

  // Playback control for the interviewer's voice: the controller for the line
  // currently playing (pause/resume), and the base64 of the last line spoken
  // (so "replay" re-speaks just that utterance, not the whole transcript).
  const currentPlaybackRef = useRef(null);
  const lastAudioB64Ref = useRef(null);

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

  // Phase machine bookkeeping.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const approachSpokeRef = useRef(false); // candidate has explained their approach at least once
  const approachStartRef = useRef(0); // when the approach phase began (fallback auto-advance)
  const readingStartRef = useRef(Date.now());
  const openedRef = useRef(false); // opening line fired once
  const codeHistoryRef = useRef([]); // recent { t, code } snapshots for thrash detection

  const interviewer = resolveInterviewer(settings.interviewerId);

  // Python: kick off the ~10MB Pyodide download when the session starts (so
  // the first Run doesn't eat the whole load), and mirror its load state into
  // a hint next to the Run button.
  const [pythonStatus, setPythonStatus] = useState(getPythonStatus());
  useEffect(() => {
    if (settings.language !== "python") return;
    const unsub = onPythonStatusChange(setPythonStatus);
    preloadPython();
    return unsub;
  }, [settings.language]);

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
      if (phaseRef.current === "approach") approachSpokeRef.current = true;
    }

    let turn;
    try {
      turn = await callGeminiInterviewTurn({
        currentProblem,
        personaDescription: interviewer.description,
        hintPosture: interviewer.hintPosture,
        code: codeRef.current,
        lastTestResults: lastTestResultsRef.current,
        transcript: transcriptSoFar,
        liveCriteria: liveCriteriaRef.current,
        language: settings.language,
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
    mergeCriteria(turn.criteriaUpdate);
    setCaption(turn.response);
    logRef.current.logTurn({ role: "interviewer", text: turn.response, progress: turn.progress, criteriaUpdate: turn.criteriaUpdate, source });

    // Speak the reply — soft-fail: the text is already the caption, so a TTS
    // hiccup or blocked autoplay must never strand the UI.
    setMicState("speaking");
    setAgentPaused(false);
    try {
      const audioB64 = await textToSpeech(turn.response, interviewer.voiceName);
      lastAudioB64Ref.current = audioB64; // enables "replay last line"
      setHasSpoken(true);
      const playback = playBase64Audio(audioB64, (v) => { amplitudeRef.current = v; });
      currentPlaybackRef.current = playback;
      await playback.finished;
      currentPlaybackRef.current = null;
    } catch (err) {
      console.warn("Text-to-Speech unavailable:", err.message);
    }
    setAgentPaused(false);
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

  // Fires a proactive interviewer turn (phase transition or stuck-hint) that
  // the candidate didn't trigger. Serialized via nudgeInFlightRef so two can't
  // overlap. Only touches stable refs/setters, so it's safe to capture in a
  // mount-once timer.
  function fireAgentTurn(latestEvent, source = "turn") {
    if (nudgeInFlightRef.current || micStateRef.current !== "idle") return;
    nudgeInFlightRef.current = true;
    setMicState("processing");
    latestRunTurnRef.current(latestEvent, null, source)
      .catch(() => {})
      .finally(() => { nudgeInFlightRef.current = false; });
  }
  const latestFireRef = useRef(fireAgentTurn);
  latestFireRef.current = fireAgentTurn;

  // --- Voice controls --------------------------------------------------
  // Mute the candidate's own input. If muted mid-recording, drop the take.
  function toggleMute() {
    setMicMuted((m) => {
      const next = !m;
      if (next && micState === "listening") {
        recorderRef.current.stop().catch(() => {});
        setMicState("idle");
      }
      return next;
    });
  }

  // Pause/resume the interviewer's current line, from exactly where it was.
  function toggleAgentPause() {
    const pb = currentPlaybackRef.current;
    if (!pb) return;
    if (pb.isPaused()) { pb.resume(); setAgentPaused(false); }
    else { pb.pause(); setAgentPaused(true); }
  }

  // Replay ONLY the last thing the interviewer said (not the whole session).
  // Enabled once idle so it can't overlap a live turn's playback.
  async function replayLast() {
    if (!lastAudioB64Ref.current || micState !== "idle") return;
    setMicState("speaking");
    setAgentPaused(false);
    const playback = playBase64Audio(lastAudioB64Ref.current, (v) => { amplitudeRef.current = v; });
    currentPlaybackRef.current = playback;
    await playback.finished;
    currentPlaybackRef.current = null;
    setMicState("idle");
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
      criteriaLog: log.criteriaLog(),
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
  // Opening line — fires once when the interview mounts: greet + announce the
  // 3-minute reading window. The reading countdown starts now.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    readingStartRef.current = Date.now();
    const t = setTimeout(() => latestFireRef.current(PHASE_EVENTS.opening), 600);
    return () => clearTimeout(t);
  }, []);

  // -----------------------------------------------------------------------
  // Reading-phase countdown (3 min). At zero, move to the approach phase and
  // have the interviewer ask how they'd implement it.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (phase !== "reading") return;
    const id = setInterval(() => {
      const left = READING_MS - (Date.now() - readingStartRef.current);
      setPhaseMsLeft(Math.max(0, left));
      if (left <= 0) {
        clearInterval(id);
        approachStartRef.current = Date.now();
        setPhase("approach");
        latestFireRef.current(PHASE_EVENTS.approach);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

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
          liveCriteria: liveCriteriaRef.current,
        });
        log.logCheckpoint(cp);
        mergeCriteria(cp.criteriaUpdate);
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
  // AGENT 3 — Watchdog + phase driver. Fires on the fast cadence: snapshots
  // keystrokes every tick (the "3-second keystroke log"), then acts by phase:
  //   • reading    → nothing (they're reading; the countdown drives the move).
  //   • approach   → once they've explained and gone quiet ~13s, ask them to
  //                  start implementing.
  //   • implementing → nudge on a sustained stuck pattern, respecting cooldown:
  //       A) silent + idle: no typing AND no turn for silentIdleMs;
  //       B) talking without progress: high filler ratio AND not coding;
  //       C) thrashing: actively editing but churning the same lines with no
  //          net progress (delete-and-retype, reverting to an earlier state).
  // -----------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const log = logRef.current;
      const code = codeRef.current;
      log.logKeystrokeSnapshot({ chars: code.length });

      const now = Date.now();
      // Keep a ~30s window of code snapshots for thrash detection.
      codeHistoryRef.current.push({ t: now, code });
      codeHistoryRef.current = codeHistoryRef.current.filter((h) => h.t >= now - 30000);

      if (wrappedRef.current || nudgeInFlightRef.current || micStateRef.current !== "idle" || errorBannerRef.current || runningTestsRef.current) return;

      const currentPhase = phaseRef.current;
      if (currentPhase === "reading") return; // reading window; let them read

      if (currentPhase === "approach") {
        // Move on to coding when they've explained and gone quiet, OR they've
        // already started typing code, OR as a fallback after ~75s so we can
        // never get wedged waiting.
        const explainedThenQuiet = approachSpokeRef.current && now - lastActivityRef.current > APPROACH_SILENCE_MS;
        const startedTyping = now - lastCodeChangeRef.current < 4000;
        const waitedTooLong = now - approachStartRef.current > 75000;
        if (explainedThenQuiet || startedTyping || waitedTooLong) {
          setPhase("implementing");
          latestFireRef.current(PHASE_EVENTS.implement);
        }
        return;
      }

      // --- implementing phase: stuck detection ---
      if (now - lastNudgeRef.current < WATCHDOG.minCooldownMs) return;
      if (remainingMsRef.current < 15000) return; // don't nudge in the last few seconds

      const silentIdle = now - lastActivityRef.current > WATCHDOG.silentIdleMs;
      const recentSpeech = log.candidateSpeechSince(log.now() - FILLER_WINDOW_MS);
      const notCoding = now - lastCodeChangeRef.current > WATCHDOG.silentIdleMs;
      const fillerNoProgress =
        recentSpeech.split(/\s+/).length >= 12 &&
        recentFillerRatio(recentSpeech) > WATCHDOG.fillerRatioThreshold &&
        notCoding;
      const thrashing = detectThrash(now);

      if (!silentIdle && !fillerNoProgress && !thrashing) return;

      const reason = silentIdle
        ? "candidate is silent and idle (no typing, no turn)"
        : thrashing
          ? "candidate is churning the same code with no net progress (looks stuck)"
          : "candidate is talking with lots of filler but not making progress";
      nudgeInFlightRef.current = true;
      lastNudgeRef.current = now;
      log.logNudge({ reason, text: "" });
      setHintsUsed((n) => n + 1);
      setMicState("processing");
      latestRunTurnRef.current(`proactive nudge — ${reason}. Offer one concrete escalating hint in character ("could you try…?"), not the full solution.`, null, "nudge")
        .catch(() => {})
        .finally(() => { nudgeInFlightRef.current = false; });
    }, WATCHDOG.checkEveryMs);
    return () => clearInterval(id);
    // Mount once; all volatile reads go through refs above.
  }, []);

  // Thrash = actively editing recently, but over the last ~20s the code churns
  // without net growth and keeps returning to an earlier state (delete/retype
  // the same lines) — a classic "stuck" signal distinct from plain idleness.
  function detectThrash(now) {
    const hist = codeHistoryRef.current.filter((h) => h.t >= now - 20000);
    if (hist.length < 4) return false;
    const editingRecently = now - lastCodeChangeRef.current < 6000;
    const first = hist[0].code;
    const last = hist[hist.length - 1].code;
    const netChange = Math.abs(last.length - first.length);
    const revertedToEarlier = hist.slice(0, -1).some((h) => h.code === last && h.code.trim() !== "");
    return editingRecently && netChange <= 4 && revertedToEarlier;
  }

  // -----------------------------------------------------------------------
  // TRIGGER 1 — voice (push to talk)
  // -----------------------------------------------------------------------
  async function handleMicClick() {
    if (errorBanner || runningTests || micMuted) return;

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
    const results = await runAllTests(codeRef.current, currentProblem.testCases, settings.language);
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

    // Right rail: interviewer avatar + captions, with the live criteria matrix
    // beneath it (ported from `main`, unified on our rubric).
    h(
      "div",
      { className: "right-rail" },
      h(Avatar, { state: micState, amplitudeRef, caption, name: interviewer.name }),
      h(CriteriaMatrix, { liveCriteria })
    ),

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
        phase === "reading" &&
          h("span", { className: "phase-pill reading" }, `📖 Read the problem · ${formatClock(phaseMsLeft)}`),
        phase === "approach" && h("span", { className: "phase-pill" }, "🗣 Explain your approach"),
        phase === "implementing" && h("span", { className: "phase-pill" }, "💻 Implement"),
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
      language: settings.language,
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
      settings.language === "python" && pythonStatus !== "ready" &&
        h("span", { className: "py-status" }, pythonStatus === "loading" ? "Loading Python runtime…" : "Python loads on first run"),
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

      // Voice control row: mute your own mic; pause/resume the interviewer
      // while it speaks, or replay just its last line once it's done.
      h(
        "div",
        { className: "voice-controls" },
        micAvailable &&
          h(
            "button",
            { className: `btn btn-small ${micMuted ? "toggle-on" : ""}`, onClick: toggleMute, "aria-pressed": micMuted },
            micMuted ? "🔇 Unmute mic" : "🎙 Mute mic"
          ),
        micState === "speaking"
          ? h("button", { className: "btn btn-small", onClick: toggleAgentPause }, agentPaused ? "▶ Resume" : "⏸ Pause")
          : h(
              "button",
              { className: "btn btn-small", onClick: replayLast, disabled: !hasSpoken || micState !== "idle" || !!errorBanner },
              "↺ Replay last"
            )
      ),

      micAvailable
        ? h(
            "button",
            {
              className: `mic-btn mic-${micState}`,
              onClick: handleMicClick,
              disabled: micMuted || micState === "processing" || micState === "speaking" || !!errorBanner || runningTests,
            },
            micMuted ? "🔇 Muted" : micLabel
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
