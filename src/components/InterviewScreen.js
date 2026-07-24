import { useState, useRef, useEffect, useMemo, h } from "../reactRuntime.js";
import CodeEditor from "./CodeEditor.js";
import AvatarOrb from "./AvatarOrb.js";
import CriteriaMatrix from "./CriteriaMatrix.js";
import { getInterviewer } from "../config.js";
import { runAllTests } from "../utils/sandbox.js";
import { preloadPython, getPythonStatus, onPythonStatusChange } from "../utils/pythonRunner.js";
import { createVoiceLoop } from "../utils/voiceLoop.js";
import { blobToBase64, prepareAudioPlayback, unlockAudioContext } from "../utils/audio.js";
import { aggregateFillerStats } from "../utils/fillerWords.js";
import { mergeCriteriaLog } from "../utils/criteria.js";
import { getAvatar } from "../api/avatarClient.js";
import { speechToText, textToSpeech } from "../api/speechClient.js";
import { callGeminiInterviewTurn, callGeminiCheckpoint, GeminiHttpError } from "../api/geminiClient.js";

// Tunable constants — named here rather than buried in logic so they're easy
// to shorten for a demo/test run without hunting through the file.
const WATCHDOG_CHECK_INTERVAL_MS = 5000;
// Hands-free listening removes push-to-talk's click friction, but thinking
// silently at the editor is still normal — keep this in the tens of seconds.
const WATCHDOG_SILENT_IDLE_THRESHOLD_MS = 45000;
const WATCHDOG_FILLER_RATIO_THRESHOLD = 0.18;
const WATCHDOG_FILLER_LOOKBACK_TURNS = 3;
const AGGREGATOR_INTERVAL_MS = 4 * 60 * 1000;
const COUNTDOWN_WARN_SECONDS = 5 * 60;
const COUNTDOWN_DANGER_SECONDS = 60;

function formatCountdown(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function initialsOf(name) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
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
  const interviewer = getInterviewer(settings.interviewerId);

  // One state machine for the conversational floor. Every turn — voice,
  // typed, Run-code reaction, watchdog nudge, greeting — moves through
  // idle → processing → speaking → idle, and turns are SERIALIZED through a
  // promise chain (turnChainRef) so two triggers can never interleave and
  // clobber each other's state.
  const [turnState, setTurnState] = useState("idle");
  const [voiceStatus, setVoiceStatus] = useState("starting"); // starting | listening | capturing | held | muted | unavailable
  const [muted, setMuted] = useState(false);
  const [textInputValue, setTextInputValue] = useState("");
  const [runningTests, setRunningTests] = useState(false);
  const [errorBanner, setErrorBanner] = useState(null); // { message, retry }
  const [activeAnalyser, setActiveAnalyser] = useState(null); // feeds the avatar ring
  const [secondsLeft, setSecondsLeft] = useState(settings.sessionLengthMinutes * 60);
  const [avatarSrc, setAvatarSrc] = useState(null);
  const [pyStatus, setPyStatus] = useState(getPythonStatus());

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
  const turnStateRef = useRef(turnState);
  useEffect(() => { turnStateRef.current = turnState; }, [turnState]);
  const errorBannerRef = useRef(errorBanner);
  useEffect(() => { errorBannerRef.current = errorBanner; }, [errorBanner]);

  // Split so the Watchdog can check "no typing AND no turn sent" as a
  // genuine dual condition.
  const lastCodeChangeAtRef = useRef(Date.now());
  const lastTurnSentAtRef = useRef(Date.now());
  const watchdogNudgeInFlightRef = useRef(false);

  const sessionStartRef = useRef(Date.now());
  const wrappedUpRef = useRef(false);
  const onWrapUpRef = useRef(onWrapUp);
  onWrapUpRef.current = onWrapUp;

  const liveCriteria = useMemo(() => mergeCriteriaLog(criteriaLog), [criteriaLog]);

  useEffect(() => {
    let cancelled = false;
    getAvatar(interviewer)
      .then((src) => { if (!cancelled) setAvatarSrc(src); })
      .catch(() => {}); // initials fallback renders instead
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, []);

  // ---------------------------------------------------------------------
  // Turn mutex. enqueueTurn guarantees one turn at a time in trigger order;
  // each job is responsible for its own error handling.
  // ---------------------------------------------------------------------
  const turnChainRef = useRef(Promise.resolve());
  function enqueueTurn(job) {
    const run = () => job();
    const next = turnChainRef.current.then(run, run);
    turnChainRef.current = next.catch(() => {});
    return next;
  }

  // Sends one turn to Gemini, appends the candidate's words (typed, or the
  // model's own transcription of their audio) and the interviewer's reply to
  // the transcript + criteriaLog, and speaks the reply via Cloud
  // Text-to-Speech in this interviewer's own voice. Only ever called from
  // inside an enqueued job.
  async function runInterviewerTurn({ latestEvent, candidateEntryText, audio }) {
    const transcriptSoFar = candidateEntryText
      ? [...transcriptRef.current, { role: "candidate", text: candidateEntryText }]
      : transcriptRef.current;
    if (candidateEntryText) {
      setTranscript(transcriptSoFar);
      transcriptRef.current = transcriptSoFar;
    }

    const turn = await callGeminiInterviewTurn({
      currentProblem,
      personaDescription: interviewer.description,
      language: settings.language,
      code: codeRef.current,
      lastTestResults: lastTestResultsRef.current,
      transcript: transcriptSoFar,
      criteriaLog: criteriaLogRef.current,
      latestEvent,
      audio,
    });

    // Audio turns carry no typed text — the model transcribes the speech so
    // the candidate's words still land in the visible transcript (and count
    // toward the local filler-word stats).
    let withCandidate = transcriptRef.current;
    if (audio && turn.candidateTranscript) {
      withCandidate = [...withCandidate, { role: "candidate", text: turn.candidateTranscript }];
    }
    const transcriptWithReply = [...withCandidate, { role: "interviewer", text: turn.response }];
    setTranscript(transcriptWithReply);
    transcriptRef.current = transcriptWithReply;

    if (Object.keys(turn.criteriaUpdate).length > 0) {
      const entry = { timestamp: Date.now(), source: "turn", criteriaUpdate: turn.criteriaUpdate };
      const nextLog = [...criteriaLogRef.current, entry];
      setCriteriaLog(nextLog);
      criteriaLogRef.current = nextLog;
    }
    lastTurnSentAtRef.current = Date.now();

    // Speak the reply — soft-fail on purpose: the text is already in the
    // transcript, so an audio hiccup never blocks the conversation.
    setTurnState("speaking");
    try {
      const base64Audio = await textToSpeech(turn.response, interviewer.voiceName);
      const { analyser, finished } = prepareAudioPlayback(base64Audio, "audio/mp3");
      setActiveAnalyser(analyser);
      await finished;
    } catch (err) {
      console.warn("Text-to-Speech unavailable:", err.message);
    }
    setActiveAnalyser(null);
    return turn;
  }

  // Standard wrapper for single-shot turns (greeting, typed input, Run code,
  // watchdog). Voice utterances need the two-stage audio→STT fallback and go
  // through sendVoiceUtterance instead.
  function sendTurn(args, { soft = false } = {}) {
    return enqueueTurn(async () => {
      setTurnState("processing");
      try {
        await runInterviewerTurn(args);
      } catch (err) {
        if (soft) {
          // A missed proactive nudge isn't worth a blocking banner for
          // something the candidate didn't ask for.
          console.warn("Turn failed:", err.message);
        } else {
          setErrorBanner({
            message: `The interviewer didn't respond: ${err.message}`,
            retry: () => {
              setErrorBanner(null);
              sendTurn(args, { soft });
            },
          });
        }
      } finally {
        setTurnState("idle");
      }
    });
  }

  // ---------------------------------------------------------------------
  // Greeting — the interview opens with the interviewer, not dead air.
  // ---------------------------------------------------------------------
  useEffect(() => {
    sendTurn({
      latestEvent:
        "session started — greet the candidate briefly, introduce yourself in character (name and role), present the problem in your own words, and invite them to talk through their initial approach before coding",
      candidateEntryText: null,
      audio: null,
    });
    // eslint-disable-next-line
  }, []);

  // ---------------------------------------------------------------------
  // Hands-free voice loop. The mic listens for the whole session; each
  // finished utterance goes to Gemini as raw audio (with the Speech-to-Text
  // fallback), and detection is held whenever the floor isn't the
  // candidate's — so the loop never records the interviewer's own reply.
  // ---------------------------------------------------------------------
  const voiceLoopRef = useRef(null);
  const levelFillRef = useRef(null);
  const handleUtteranceRef = useRef(null);

  useEffect(() => {
    const loop = createVoiceLoop({
      onUtterance: (blob) => handleUtteranceRef.current && handleUtteranceRef.current(blob),
      // Direct DOM write — this fires every 50ms and would be wasteful as
      // React state.
      onLevel: (rms) => {
        if (levelFillRef.current) {
          levelFillRef.current.style.transform = `scaleX(${Math.min(1, rms * 14).toFixed(3)})`;
        }
      },
      onStatusChange: (status) => setVoiceStatus(status),
    });
    voiceLoopRef.current = loop;
    // Mic permission denied (or no mic) → run the session as text-only.
    loop.start().catch(() => setVoiceStatus("unavailable"));
    return () => loop.stop();
    // eslint-disable-next-line
  }, []);

  // The loop only listens while the turn floor is open.
  useEffect(() => {
    const loop = voiceLoopRef.current;
    if (!loop) return;
    if (turnState === "idle" && !errorBanner && !runningTests) loop.resume();
    else loop.hold();
  }, [turnState, errorBanner, runningTests]);

  async function handleUtterance(blob) {
    if (errorBannerRef.current) return;
    let base64;
    try {
      base64 = await blobToBase64(blob);
    } catch (err) {
      console.warn("Could not read utterance:", err.message);
      return;
    }
    sendVoiceUtterance(base64, blob.type || "audio/webm");
  }
  handleUtteranceRef.current = handleUtterance;

  function sendVoiceUtterance(base64, mimeType) {
    return enqueueTurn(async () => {
      setTurnState("processing");
      let fellThroughTo400 = false;
      try {
        // Attempt 1: native audio-in, per the spec — richer than transcribed
        // text alone (tone/hesitation/fluency). May 400 since Gemini's
        // documented input formats don't include webm/opus.
        await runInterviewerTurn({
          latestEvent: "candidate spoke (raw audio attached)",
          candidateEntryText: null,
          audio: { base64, mimeType },
        });
      } catch (err) {
        if (err instanceof GeminiHttpError && err.status === 400) {
          fellThroughTo400 = true; // → Speech-to-Text fallback below
        } else {
          setErrorBanner({
            message: `The interviewer didn't respond: ${err.message}`,
            retry: () => {
              setErrorBanner(null);
              sendVoiceUtterance(base64, mimeType);
            },
          });
        }
      }

      if (fellThroughTo400) {
        try {
          const candidateText = await speechToText(base64);
          await runInterviewerTurn({
            latestEvent: `candidate said: "${candidateText}"`,
            candidateEntryText: candidateText,
            audio: null,
          });
        } catch (err) {
          setErrorBanner({
            message: `Couldn't process what you said: ${err.message}`,
            retry: () => setErrorBanner(null),
          });
        }
      }
      setTurnState("idle");
    });
  }

  function handleToggleMute() {
    const next = !muted;
    setMuted(next);
    if (voiceLoopRef.current) voiceLoopRef.current.setMuted(next);
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
  useEffect(() => {
    const interval = setInterval(() => {
      if (turnStateRef.current !== "idle" || errorBannerRef.current || watchdogNudgeInFlightRef.current) return;

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
      const reason = fillerWithoutProgress
        ? "watchdog: high filler-word ratio with little new code across recent turns — candidate may be talking without making progress"
        : "watchdog: candidate has been silent and not typing for a while — may be stuck";
      sendTurn({ latestEvent: reason, candidateEntryText: null, audio: null }, { soft: true }).finally(() => {
        watchdogNudgeInFlightRef.current = false;
      });
    }, WATCHDOG_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line
  }, []);

  // ---------------------------------------------------------------------
  // AGENT 2 — Aggregator. Fires on its own timer, independent of turns, and
  // analyzes the whole window since the last checkpoint. A window with no
  // new transcript AND no code change is itself a signal — but only once:
  // consecutive dead windows skip the call instead of burning quota
  // repeating the same observation.
  // ---------------------------------------------------------------------
  const checkpointInFlightRef = useRef(false);
  const transcriptAtLastCheckpointRef = useRef([]);
  const codeAtLastCheckpointRef = useRef(code);
  const lastWindowWasDeadRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (checkpointInFlightRef.current) return;

      const transcriptSlice = transcriptRef.current.slice(transcriptAtLastCheckpointRef.current.length);
      const codeUnchanged = codeRef.current === codeAtLastCheckpointRef.current;
      if (transcriptSlice.length === 0 && codeUnchanged) {
        if (lastWindowWasDeadRef.current) return;
        lastWindowWasDeadRef.current = true;
      } else {
        lastWindowWasDeadRef.current = false;
      }
      checkpointInFlightRef.current = true;

      try {
        const { criteriaUpdate } = await callGeminiCheckpoint({
          currentProblem,
          language: settings.language,
          code: codeRef.current,
          transcriptSlice,
          codeChangeSummary: codeUnchanged
            ? "No code changes since the last checkpoint."
            : "The candidate edited their code since the last checkpoint.",
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
  // Python runtime preload — pay the Pyodide download before the first Run.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (settings.language !== "python") return;
    preloadPython();
    setPyStatus(getPythonStatus());
    return onPythonStatusChange(setPyStatus);
    // eslint-disable-next-line
  }, []);

  // ---------------------------------------------------------------------
  // Typed input — always available alongside voice.
  // ---------------------------------------------------------------------
  function handleSubmitText(e) {
    e.preventDefault();
    unlockAudioContext(); // a genuine gesture — reuse it to keep TTS unlocked
    const text = textInputValue.trim();
    if (!text || errorBanner) return;
    setTextInputValue("");
    sendTurn({ latestEvent: `candidate said: "${text}"`, candidateEntryText: text, audio: null });
  }

  // ---------------------------------------------------------------------
  // Run code — tests run immediately (even while the interviewer is
  // talking); the interviewer's reaction queues like any other turn.
  // ---------------------------------------------------------------------
  async function handleRunCode() {
    if (runningTests || errorBanner) return;
    setRunningTests(true);
    const results = await runAllTests(codeRef.current, currentProblem.testCases, settings.language);
    setLastTestResults(results);
    lastTestResultsRef.current = results;
    setRunningTests(false);
    sendTurn({ latestEvent: "candidate just ran their code", candidateEntryText: null, audio: null });
  }

  // ---------------------------------------------------------------------
  // Transcript auto-scroll — new entries (and the typing indicator) always
  // come into view without manual scrolling.
  // ---------------------------------------------------------------------
  const transcriptBoxRef = useRef(null);
  useEffect(() => {
    if (transcriptBoxRef.current) {
      transcriptBoxRef.current.scrollTop = transcriptBoxRef.current.scrollHeight;
    }
  }, [transcript, turnState]);

  const firstName = interviewer.name.split(" ")[0];
  const voicePill = (() => {
    if (voiceStatus === "unavailable") return { className: "pill-unavailable", label: "Mic unavailable — type below" };
    if (muted) return { className: "pill-muted", label: "Muted" };
    if (turnState === "processing") return { className: "pill-processing", label: "Thinking…" };
    if (turnState === "speaking") return { className: "pill-speaking", label: `${firstName} is speaking…` };
    if (voiceStatus === "capturing") return { className: "pill-capturing", label: "● Hearing you…" };
    if (voiceStatus === "starting") return { className: "pill-idle", label: "Starting mic…" };
    return { className: "pill-idle", label: "Listening — just talk" };
  })();

  const passedCount = lastTestResults.filter((t) => t.passed).length;
  const countdownClass =
    secondsLeft <= COUNTDOWN_DANGER_SECONDS ? " danger" : secondsLeft <= COUNTDOWN_WARN_SECONDS ? " warn" : "";

  return h(
    "div",
    { className: "screen interview-screen" },

    h(
      "header",
      { className: "topbar" },
      h(
        "div",
        { className: "topbar-side" },
        h("span", { className: "brand" }, "Mock Interview Agent"),
        h("span", { className: `badge badge-${currentProblem.difficulty}` }, currentProblem.difficulty)
      ),
      h("div", { className: `session-countdown${countdownClass}` }, formatCountdown(secondsLeft)),
      h(
        "div",
        { className: "topbar-side topbar-right" },
        voiceStatus !== "unavailable" &&
          h(
            "button",
            { className: "btn btn-small", onClick: handleToggleMute, "aria-pressed": muted },
            muted ? "🔇 Unmute" : "🎙 Mute"
          ),
        h("button", { className: "btn btn-wrapup", onClick: onWrapUp }, "Wrap up interview")
      )
    ),

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
            h("span", { className: `badge badge-${currentProblem.difficulty}` }, currentProblem.difficulty)
          ),
          h("p", { className: "problem-description" }, currentProblem.description),
          (currentProblem.examples || []).map((ex, i) =>
            h(
              "div",
              { key: i, className: "problem-example" },
              h("div", { className: "example-title" }, `Example ${i + 1}`),
              h(
                "pre",
                { className: "example-body" },
                `Input: ${ex.input}\nOutput: ${ex.output}${ex.explanation ? `\nExplanation: ${ex.explanation}` : ""}`
              )
            )
          ),
          currentProblem.constraints &&
            h(
              "div",
              { className: "problem-constraints" },
              h("div", { className: "example-title" }, "Constraints"),
              h(
                "ul",
                null,
                currentProblem.constraints.map((c, i) => h("li", { key: i }, h("code", null, c)))
              )
            )
        ),

        h(CodeEditor, {
          key: `${currentProblem.id}:${settings.language}`,
          initialCode: code,
          language: settings.language,
          onChange: (next) => {
            setCode(next);
            lastCodeChangeAtRef.current = Date.now();
          },
        }),

        h(
          "div",
          { className: "run-panel" },
          h(
            "div",
            { className: "run-header" },
            h(
              "button",
              { className: "btn btn-primary", onClick: handleRunCode, disabled: runningTests || !!errorBanner },
              runningTests ? "Running…" : "Run code"
            ),
            settings.language === "python" && pyStatus === "loading"
              ? h("span", { className: "muted" }, "Loading Python runtime…")
              : lastTestResults.length > 0
                ? h(
                    "span",
                    { className: `run-summary ${passedCount === lastTestResults.length ? "all-pass" : "has-fail"}` },
                    `${passedCount}/${lastTestResults.length} passed`
                  )
                : null
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
          { className: "interviewer-header" },
          h(AvatarOrb, {
            analyser: activeAnalyser,
            active: turnState === "speaking",
            imageSrc: avatarSrc,
            initials: initialsOf(interviewer.name),
          }),
          h(
            "div",
            { className: "interviewer-id" },
            h("span", { className: "interviewer-name" }, interviewer.name),
            h("span", { className: "interviewer-title" }, interviewer.title)
          )
        ),

        h(
          "div",
          { className: `voice-pill ${voicePill.className}` },
          h("span", { className: "voice-pill-label" }, voicePill.label),
          h(
            "span",
            { className: "level-meter", "aria-hidden": true },
            h("span", { className: "level-fill", ref: levelFillRef })
          )
        ),

        h(CriteriaMatrix, { liveCriteria }),

        h(
          "div",
          { className: "transcript", ref: transcriptBoxRef },
          transcript.length === 0 &&
            turnState === "idle" &&
            h("p", { className: "muted" }, `${interviewer.name} is joining…`),
          transcript.map((entry, i) =>
            h(
              "div",
              { key: i, className: `transcript-entry role-${entry.role}` },
              h("span", { className: "role-label" }, entry.role === "interviewer" ? interviewer.name : "You"),
              h("span", { className: "entry-text" }, entry.text)
            )
          ),
          turnState === "processing" &&
            h(
              "div",
              { className: "transcript-entry role-interviewer" },
              h("span", { className: "role-label" }, interviewer.name),
              h(
                "span",
                { className: "entry-text typing-dots", "aria-label": `${interviewer.name} is thinking` },
                h("span"),
                h("span"),
                h("span")
              )
            )
        ),

        h(
          "form",
          { className: "text-fallback", onSubmit: handleSubmitText },
          h("input", {
            type: "text",
            placeholder:
              voiceStatus === "unavailable" ? "Mic unavailable — type to the interviewer" : "Or type instead of talking…",
            value: textInputValue,
            onChange: (e) => setTextInputValue(e.target.value),
            disabled: !!errorBanner,
          }),
          h("button", { className: "btn btn-small", type: "submit", disabled: !!errorBanner }, "Send")
        )
      )
    )
  );
}
