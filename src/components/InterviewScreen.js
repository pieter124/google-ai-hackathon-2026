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
import { getAvatar, getAvatarVariant, getAvatarVideoUrl } from "../api/avatarClient.js";
import { speechToText, textToSpeech } from "../api/speechClient.js";
import { callGeminiInterviewTurn, callGeminiCheckpoint, GeminiHttpError } from "../api/geminiClient.js";

const WATCHDOG_CHECK_INTERVAL_MS = 5000;
// Interviewer only checks in after this long without candidate input.
const WATCHDOG_CHECKIN_SILENCE_MS = 90000;
const WATCHDOG_FILLER_RATIO_THRESHOLD = 0.18;
const WATCHDOG_FILLER_LOOKBACK_TURNS = 3;
const AGGREGATOR_INTERVAL_MS = 4 * 60 * 1000;
// Thrash detection — the third stuck signal, for someone whose hands are busy
// but who isn't getting anywhere. Tuned against the 5s snapshot cadence above.
const THRASH_WINDOW_MS = 30000;
const THRASH_MIN_SNAPSHOTS = 4;
const THRASH_ACTIVE_EDIT_MS = 8000; // last keystroke this recent = still editing
const THRASH_MAX_NET_CHARS = 8; // net change across the window that still counts as standing still
const THRASH_MIN_CODE_CHARS = 40; // below this they're barely started, not stuck
const COUNTDOWN_WARN_SECONDS = 5 * 60;
const COUNTDOWN_DANGER_SECONDS = 60;
// Barge-in must sustain this long before we cut the TTS, to absorb echo blips.
const BARGE_IN_SUSTAIN_MS = 600;
// Mic threshold multiplier while the reply plays, so echo can't trigger capture.
const BARGE_IN_THRESHOLD_BOOST = 2.5;

// A real interview isn't one undifferentiated block — you get a few minutes
// with the problem, you talk through a plan, and only then do you write code.
// The session walks those three phases in order, which is also the talk-ratio
// U-curve from RESEARCH.md: chatty at the top, near-silent while coding.
const READING_PHASE_MS = 3 * 60 * 1000;
// Once they've explained their approach and gone quiet for this long, take it
// as "done explaining" and move them to the keyboard.
const APPROACH_SILENCE_MS = 13000;
// ...and if they never quite land it, move on anyway rather than stall here.
const APPROACH_MAX_MS = 75000;
// Recently-typed means they've already started coding, so the approach phase
// has effectively ended whether or not they narrated it.
const APPROACH_TYPING_GRACE_MS = 4000;

// Phase transitions are described to Agent 1 as ordinary `latestEvent` text
// rather than canned lines, so each interviewer delivers them in their own
// voice instead of all four sounding like the same script.
const PHASE_EVENTS = {
  opening:
    "session started — greet the candidate briefly and introduce yourself in character (name and role). Then set up the task in your own words: two or three spoken sentences capturing what the problem asks — do NOT read the full problem statement aloud, it's already on their screen — plus one quick example spoken naturally so they hear what goes in and what comes out. Then tell them they have 3 minutes to read the problem and its constraints and to ask any clarifying questions, and that you'll ask for their approach after that. Do NOT discuss the solution or an approach yet. A bit longer than a normal turn is fine; keep it well under 30 seconds of speech.",
  approach:
    "the 3-minute reading window is up — ask the candidate to walk you through how they'd approach this, out loud, before they write any code. If they haven't asked a clarifying question yet, invite one",
  implement:
    "the candidate has explained their approach — acknowledge it briefly and ask them to start implementing it in code now",
};

const PHASE_PILLS = {
  reading: { className: "phase-reading", label: "Read the problem" },
  approach: { className: "phase-approach", label: "Explain your approach" },
  implementing: { className: "phase-implementing", label: "Implement" },
};

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

// Types the interviewer's reply out like a live caption. `cps` (chars/sec)
// matches the voice when it's on, and runs faster when the reply is text-only.
function TypedText({ text, onGrow, cps = 15 }) {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    setVisibleCount(0);
    const interval = setInterval(() => {
      setVisibleCount((count) => {
        const next = Math.min(text.length, count + 1);
        if (next >= text.length) clearInterval(interval);
        return next;
      });
    }, Math.round(1000 / cps));
    return () => clearInterval(interval);
  }, [text]);

  // Keep the growing text pinned to the bottom of the transcript.
  useEffect(() => {
    if (onGrow) onGrow();
    // eslint-disable-next-line
  }, [visibleCount]);

  return h("span", { className: "entry-text" }, text.slice(0, visibleCount));
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
  setProgressSeries,
  watchdogNudgeCount,
  setWatchdogNudgeCount,
  onWrapUp,
}) {
  const interviewer = getInterviewer(settings.interviewerId);

  // Turn state machine: idle → processing → speaking → idle. Turns are
  // serialized through turnChainRef so triggers can't interleave.
  const [turnState, setTurnState] = useState("idle");
  const [voiceStatus, setVoiceStatus] = useState("starting"); // starting | listening | capturing | held | muted | unavailable
  const [muted, setMuted] = useState(false);
  const [agentPaused, setAgentPaused] = useState(false);
  const [hasSpokenLine, setHasSpokenLine] = useState(false); // enables Replay once there's something to replay
  const [textInputValue, setTextInputValue] = useState("");
  const [runningTests, setRunningTests] = useState(false);
  const [errorBanner, setErrorBanner] = useState(null); // { message, retry }
  const [activeLevelSource, setActiveLevelSource] = useState(null); // reply amplitude fn, feeds the avatar
  const [secondsLeft, setSecondsLeft] = useState(settings.sessionLengthMinutes * 60);
  // Portrait + mouth-open + blink frames; each lands when its generation resolves.
  const [avatarFrames, setAvatarFrames] = useState({ base: null, talking: null, blink: null });
  const [avatarVideoSrc, setAvatarVideoSrc] = useState(null); // pre-generated Veo talking loop, if any
  const [voiceOverOn, setVoiceOverOn] = useState(true);
  const voiceOverOnRef = useRef(true);
  useEffect(() => { voiceOverOnRef.current = voiceOverOn; }, [voiceOverOn]);
  const [pyStatus, setPyStatus] = useState(getPythonStatus());
  const [phase, setPhase] = useState("reading"); // reading | approach | implementing
  const [readingSecondsLeft, setReadingSecondsLeft] = useState(Math.round(READING_PHASE_MS / 1000));

  // Refs mirror state so async callbacks never read stale values.
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

  // Split so the watchdog can check "no typing AND no turn sent" separately.
  const lastCodeChangeAtRef = useRef(Date.now());
  const lastTurnSentAtRef = useRef(Date.now());
  const watchdogNudgeInFlightRef = useRef(false);
  const codeHistoryRef = useRef([]); // rolling { at, code } snapshots for thrash detection

  // The <audio> element for the line playing right now (so it can be paused
  // where it stands), and the base64 of the last line spoken (so Replay
  // re-speaks that one utterance rather than re-running the turn).
  const currentAudioRef = useRef(null);
  const lastReplyAudioRef = useRef(null);

  // Phase bookkeeping. `lastCandidateActivityAtRef` deliberately tracks only
  // things the CANDIDATE did — unlike lastTurnSentAtRef, which also moves when
  // the interviewer speaks unprompted, and so can't answer "have they gone
  // quiet since explaining?".
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const readingStartedAtRef = useRef(Date.now());
  const approachStartedAtRef = useRef(0);
  const approachSpokeRef = useRef(false);
  const lastCandidateActivityAtRef = useRef(Date.now());

  const sessionStartRef = useRef(Date.now());
  const wrappedUpRef = useRef(false);
  const onWrapUpRef = useRef(onWrapUp);
  onWrapUpRef.current = onWrapUp;

  const liveCriteria = useMemo(() => mergeCriteriaLog(criteriaLog), [criteriaLog]);

  useEffect(() => {
    let cancelled = false;
    const merge = (partial) => {
      if (!cancelled) setAvatarFrames((prev) => ({ ...prev, ...partial }));
    };
    getAvatar(interviewer)
      .then((base) => {
        merge({ base });
        // Frames are progressive enhancement; a failed one just skips that part.
        getAvatarVariant(interviewer, "talking").then((talking) => merge({ talking })).catch(() => {});
        getAvatarVariant(interviewer, "blink").then((blink) => merge({ blink })).catch(() => {});
      })
      .catch(() => {}); // initials fallback renders instead
    getAvatarVideoUrl(interviewer).then((url) => {
      if (!cancelled && url) setAvatarVideoSrc(url);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, []);

  // Anything the candidate did of their own accord: spoke, typed a message,
  // edited code, ran tests. Speaking during the approach phase is also what
  // arms the "they've explained it, let them code" transition.
  // One point on the path chart. Time is relative to the start of the
  // interview so the chart reads as "how far in", not wall clock.
  function recordProgress(progress) {
    if (typeof progress !== "number") return;
    setProgressSeries((series) => [...series, { t: Date.now() - sessionStartRef.current, progress }]);
  }

  function noteCandidateActivity() {
    lastCandidateActivityAtRef.current = Date.now();
    if (phaseRef.current === "approach") approachSpokeRef.current = true;
  }

  // Turn mutex: one turn at a time, in trigger order. Each job handles its own errors.
  const turnChainRef = useRef(Promise.resolve());
  function enqueueTurn(job) {
    const run = () => job();
    const next = turnChainRef.current.then(run, run);
    turnChainRef.current = next.catch(() => {});
    return next;
  }

  // Sends one turn to Gemini, appends the candidate's words and the reply to
  // the transcript + criteriaLog, and speaks the reply. Only called from an
  // enqueued job.
  async function runInterviewerTurn({ latestEvent, candidateEntryText, audio }) {
    const transcriptSoFar = candidateEntryText
      ? [...transcriptRef.current, { role: "candidate", text: candidateEntryText }]
      : transcriptRef.current;
    if (candidateEntryText) {
      setTranscript(transcriptSoFar);
      transcriptRef.current = transcriptSoFar;
      noteCandidateActivity();
    }

    const turn = await callGeminiInterviewTurn({
      currentProblem,
      personaDescription: interviewer.description,
      hintPosture: interviewer.hintPosture,
      phase: phaseRef.current,
      language: settings.language,
      code: codeRef.current,
      lastTestResults: lastTestResultsRef.current,
      transcript: transcriptSoFar,
      criteriaLog: criteriaLogRef.current,
      latestEvent,
      audio,
    });

    // Audio turns carry no typed text — the model's transcription lands in the
    // transcript so the candidate's words still show and count toward filler stats.
    if (audio && turn.candidateTranscript) {
      const withCandidate = [...transcriptRef.current, { role: "candidate", text: turn.candidateTranscript }];
      setTranscript(withCandidate);
      transcriptRef.current = withCandidate;
      noteCandidateActivity();
    }

    // Synthesize before revealing the reply so text and voice start together;
    // the thinking dots cover the wait, and TTS failure soft-fails to text-only.
    let base64Audio = null;
    if (voiceOverOnRef.current) {
      try {
        base64Audio = await textToSpeech(turn.response, interviewer.voiceName);
      } catch (err) {
        console.warn("Text-to-Speech unavailable:", err.message);
      }
    }

    const transcriptWithReply = [...transcriptRef.current, { role: "interviewer", text: turn.response }];
    setTranscript(transcriptWithReply);
    transcriptRef.current = transcriptWithReply;

    recordProgress(turn.progress);

    if (Object.keys(turn.criteriaUpdate).length > 0) {
      const entry = { timestamp: Date.now(), source: "turn", criteriaUpdate: turn.criteriaUpdate };
      const nextLog = [...criteriaLogRef.current, entry];
      setCriteriaLog(nextLog);
      criteriaLogRef.current = nextLog;
    }
    lastTurnSentAtRef.current = Date.now();

    // Stash the stop handle so barge-in or Skip can cut playback short, and
    // the element itself so Pause can hold it mid-sentence.
    // Re-check voice-over in case it was toggled off during synthesis.
    if (base64Audio && voiceOverOnRef.current) {
      lastReplyAudioRef.current = base64Audio; // enables Replay
      setHasSpokenLine(true);
      setTurnState("speaking");
      setAgentPaused(false);
      const { audio, getLevel, finished, stop } = prepareAudioPlayback(base64Audio, "audio/mp3");
      currentAudioRef.current = audio;
      stopPlaybackRef.current = stop;
      setActiveLevelSource(() => getLevel); // wrapped: bare fn would be treated as an updater
      await finished;
      currentAudioRef.current = null;
      stopPlaybackRef.current = null;
      setActiveLevelSource(null);
      setAgentPaused(false);
    }
    return turn;
  }

  // Wrapper for single-shot turns (greeting, typed input, Run code, watchdog).
  // Voice utterances use sendVoiceUtterance for the audio→STT fallback.
  function sendTurn(args, { soft = false } = {}) {
    return enqueueTurn(async () => {
      setTurnState("processing");
      try {
        await runInterviewerTurn(args);
      } catch (err) {
        if (soft) {
          // A missed proactive nudge isn't worth a blocking error banner.
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

  // Greeting — open with the interviewer, not dead air. This also starts the
  // reading clock, so the 3 minutes begin when the candidate first sees the
  // problem rather than when the component mounted.
  useEffect(() => {
    readingStartedAtRef.current = Date.now();
    sendTurn({ latestEvent: PHASE_EVENTS.opening, candidateEntryText: null, audio: null });
    // eslint-disable-next-line
  }, []);

  // Reading phase — count the three minutes down in the top bar, then hand
  // over to the approach phase. The transition is enqueued like any other
  // turn, so it waits its turn instead of talking over a question the
  // candidate is part-way through asking.
  useEffect(() => {
    if (phase !== "reading") return;
    const interval = setInterval(() => {
      const remaining = READING_PHASE_MS - (Date.now() - readingStartedAtRef.current);
      setReadingSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
      if (remaining <= 0) {
        clearInterval(interval);
        approachStartedAtRef.current = Date.now();
        setPhase("approach");
        phaseRef.current = "approach";
        sendTurn({ latestEvent: PHASE_EVENTS.approach, candidateEntryText: null, audio: null }, { soft: true });
      }
    }, 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line
  }, [phase]);

  // Hands-free voice loop: the mic listens all session; each utterance goes to
  // Gemini as raw audio (with STT fallback). Detection is held while the floor
  // isn't the candidate's, so it never records the interviewer's own reply.
  const voiceLoopRef = useRef(null);
  const levelFillRef = useRef(null);
  const handleUtteranceRef = useRef(null);
  const stopPlaybackRef = useRef(null);
  const voiceStatusRef = useRef(voiceStatus);
  useEffect(() => { voiceStatusRef.current = voiceStatus; }, [voiceStatus]);

  useEffect(() => {
    const loop = createVoiceLoop({
      onUtterance: (blob) => handleUtteranceRef.current && handleUtteranceRef.current(blob),
      // Direct DOM write — fires every 50ms, too hot for React state.
      onLevel: (rms) => {
        if (levelFillRef.current) {
          levelFillRef.current.style.transform = `scaleX(${Math.min(1, rms * 14).toFixed(3)})`;
        }
      },
      onStatusChange: (status) => setVoiceStatus(status),
      // Barge-in: candidate talks over the reply → cut the TTS short. Only
      // fires after speech sustains past the guard, so a cough doesn't trigger it.
      onSpeechStart: () => {
        if (turnStateRef.current !== "speaking") return;
        setTimeout(() => {
          if (
            turnStateRef.current === "speaking" &&
            voiceStatusRef.current === "capturing" &&
            stopPlaybackRef.current
          ) {
            stopPlaybackRef.current();
          }
        }, BARGE_IN_SUSTAIN_MS);
      },
    });
    voiceLoopRef.current = loop;
    // Mic permission denied (or no mic) → run the session as text-only.
    loop.start().catch(() => setVoiceStatus("unavailable"));
    return () => {
      loop.stop();
      // Silence any in-progress reply so it doesn't bleed into the scorecard.
      if (stopPlaybackRef.current) stopPlaybackRef.current();
    };
    // eslint-disable-next-line
  }, []);

  // Listen while the floor is open (including during the reply, for barge-in,
  // at reduced sensitivity); hold only while a turn is processing.
  useEffect(() => {
    const loop = voiceLoopRef.current;
    if (!loop) return;
    loop.setThresholdBoost(turnState === "speaking" ? BARGE_IN_THRESHOLD_BOOST : 1);
    if ((turnState === "idle" || turnState === "speaking") && !errorBanner && !runningTests) loop.resume();
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
        // Prefer native audio-in (captures tone/hesitation, not just words).
        // May 400 since Gemini's input formats don't include webm/opus.
        await runInterviewerTurn({
          latestEvent: "candidate spoke (raw audio attached)",
          candidateEntryText: null,
          audio: { base64, mimeType },
        });
      } catch (err) {
        if (err instanceof GeminiHttpError && err.status === 400) {
          fellThroughTo400 = true; // fall back to Speech-to-Text below
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

  function handleToggleVoiceOver() {
    const next = !voiceOverOn;
    setVoiceOverOn(next);
    // Turning it off mid-sentence cuts the current reply short.
    if (!next && stopPlaybackRef.current) stopPlaybackRef.current();
  }

  function handleSkipSpeech() {
    if (stopPlaybackRef.current) stopPlaybackRef.current();
  }

  // Hold the interviewer mid-sentence — for taking a note, or re-reading the
  // problem without them talking over you. Distinct from Skip, which abandons
  // the rest of the line. The turn stays in "speaking" while paused, which is
  // deliberate: the mic keeps its hold, so pausing doesn't turn into the app
  // recording you with the reply half-delivered.
  function handleTogglePause() {
    const audio = currentAudioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
      setAgentPaused(false);
    } else {
      audio.pause();
      setAgentPaused(true);
    }
  }

  // Say that last line again. Faithful and free next to asking the interviewer
  // to repeat themselves — it replays the exact audio instead of spending a
  // turn on a paraphrase that won't match what they actually said.
  function handleReplayLast() {
    if (!lastReplyAudioRef.current || turnState !== "idle" || errorBanner) return;
    unlockAudioContext();
    enqueueTurn(async () => {
      setTurnState("speaking");
      setAgentPaused(false);
      const { audio, getLevel, finished, stop } = prepareAudioPlayback(lastReplyAudioRef.current, "audio/mp3");
      currentAudioRef.current = audio;
      stopPlaybackRef.current = stop;
      setActiveLevelSource(() => getLevel);
      await finished;
      currentAudioRef.current = null;
      stopPlaybackRef.current = null;
      setActiveLevelSource(null);
      setAgentPaused(false);
      setTurnState("idle");
    });
  }

  // Session countdown — auto-wraps-up at zero, same flow as the manual button.
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

  // Watchdog: background monitor of typing activity, time since the last turn,
  // and recent filler-word ratio. Fires a proactive nudge when a threshold trips.
  //
  // It also drives the phase machine past the approach stage — deciding
  // "they've finished explaining" reads the same activity signals as deciding
  // "they've gone quiet", so it belongs on the same timer.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      // Snapshot first, unconditionally — thrash detection needs an unbroken
      // record of the code, including across ticks the guards below skip.
      codeHistoryRef.current.push({ at: now, code: codeRef.current });
      codeHistoryRef.current = codeHistoryRef.current.filter((snap) => snap.at >= now - THRASH_WINDOW_MS);

      if (turnStateRef.current !== "idle" || errorBannerRef.current || watchdogNudgeInFlightRef.current) return;

      // Reading time is theirs — silence here is the candidate doing exactly
      // what they were asked to do, so no check-in fires at all.
      if (phaseRef.current === "reading") return;

      // The approach phase has its own, much shorter clock: it ends when
      // they've explained and gone quiet, or they've already started typing,
      // or they've had long enough either way. It runs ahead of the cadence
      // cap below so the handoff isn't stuck waiting a full silence window.
      if (phaseRef.current === "approach") {
        const explainedThenQuiet =
          approachSpokeRef.current && now - lastCandidateActivityAtRef.current > APPROACH_SILENCE_MS;
        const alreadyCoding = now - lastCodeChangeAtRef.current < APPROACH_TYPING_GRACE_MS;
        const waitedLongEnough = now - approachStartedAtRef.current > APPROACH_MAX_MS;
        if (explainedThenQuiet || alreadyCoding || waitedLongEnough) {
          setPhase("implementing");
          phaseRef.current = "implementing";
          sendTurn({ latestEvent: PHASE_EVENTS.implement, candidateEntryText: null, audio: null }, { soft: true });
        }
        return;
      }

      // Cadence cap: never check in unless a full silence window has
      // passed since the last turn. Everything below only picks the tone.
      if (now - lastTurnSentAtRef.current <= WATCHDOG_CHECKIN_SILENCE_MS) return;
      const typingRecently = now - lastCodeChangeAtRef.current < WATCHDOG_CHECKIN_SILENCE_MS;

      const recentCandidateTexts = transcriptRef.current
        .filter((e) => e.role === "candidate")
        .slice(-WATCHDOG_FILLER_LOOKBACK_TURNS)
        .map((e) => e.text);
      const fillerRatio = recentCandidateTexts.length > 0 ? aggregateFillerStats(recentCandidateTexts).ratio : 0;
      const fillerWithoutProgress =
        recentCandidateTexts.length >= 2 &&
        fillerRatio > WATCHDOG_FILLER_RATIO_THRESHOLD &&
        !typingRecently;

      // Typing hard and getting nowhere reads as "coding silently" to the
      // check-in above, which would ask them to narrate. Detecting the churn
      // lets the interviewer offer a hint instead, which is what they need.
      const thrashing = typingRecently && detectThrash(now);

      watchdogNudgeInFlightRef.current = true;
      lastTurnSentAtRef.current = now; // next check-in is another full silence window away
      setWatchdogNudgeCount((n) => n + 1);
      const reason = thrashing
        ? "watchdog: the candidate keeps rewriting the same few lines and ending up back where they started — they look stuck mid-implementation, so offer the smallest hint that unblocks them rather than asking them to narrate"
        : fillerWithoutProgress
          ? "watchdog: high filler-word ratio with little new code across recent turns — candidate may be talking without making progress"
          : typingRecently
            ? "watchdog check-in: the candidate has been coding silently for a while — in ONE short sentence, politely ask them to talk through what they're doing; do NOT give hints or comment on the code's direction"
            : "watchdog check-in: the candidate has been silent and inactive for a while — check in briefly and ask how it's going; offer the smallest possible hint only if they were already stuck at the last check-in too";
      sendTurn({ latestEvent: reason, candidateEntryText: null, audio: null }, { soft: true }).finally(() => {
        watchdogNudgeInFlightRef.current = false;
      });
    }, WATCHDOG_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line
  }, []);

  // Wheel-spinning: they're clearly still typing, but over the last half-minute
  // the code hasn't grown and has come back to a state it already passed
  // through — delete a line, retype it, delete it again. It's a different
  // failure from going quiet, and the activity checks above can't see it
  // because the keystrokes keep the typing timer permanently fresh.
  // See RESEARCH.md.
  function detectThrash(now) {
    const history = codeHistoryRef.current;
    if (history.length < THRASH_MIN_SNAPSHOTS) return false;
    if (now - lastCodeChangeAtRef.current > THRASH_ACTIVE_EDIT_MS) return false; // not actually editing

    const latest = history[history.length - 1].code;
    if (latest.trim().length < THRASH_MIN_CODE_CHARS) return false; // an empty editor isn't thrashing
    const netGrowth = Math.abs(latest.length - history[0].code.length);
    if (netGrowth > THRASH_MAX_NET_CHARS) return false; // real forward progress

    return history.slice(0, -1).some((snap) => snap.code === latest);
  }

  // Aggregator: fires on its own timer and analyzes the whole window since the
  // last checkpoint. Consecutive dead windows (no transcript, no code change)
  // skip the call instead of burning quota.
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
        const { progress, criteriaUpdate } = await callGeminiCheckpoint({
          currentProblem,
          language: settings.language,
          code: codeRef.current,
          transcriptSlice,
          codeChangeSummary: codeUnchanged
            ? "No code changes since the last checkpoint."
            : "The candidate edited their code since the last checkpoint.",
          criteriaLog: criteriaLogRef.current,
        });
        recordProgress(progress);
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

  // Preload the Pyodide runtime before the first Run.
  useEffect(() => {
    if (settings.language !== "python") return;
    preloadPython();
    setPyStatus(getPythonStatus());
    return onPythonStatusChange(setPyStatus);
    // eslint-disable-next-line
  }, []);

  // Typed input — always available alongside voice.
  function handleSubmitText(e) {
    e.preventDefault();
    unlockAudioContext(); // a genuine gesture — reuse it to keep TTS unlocked
    const text = textInputValue.trim();
    if (!text || errorBanner) return;
    setTextInputValue("");
    sendTurn({ latestEvent: `candidate said: "${text}"`, candidateEntryText: text, audio: null });
  }

  // Run code — tests run immediately; the interviewer's reaction queues as a turn.
  async function handleRunCode() {
    if (runningTests || errorBanner) return;
    noteCandidateActivity();
    setRunningTests(true);
    const results = await runAllTests(codeRef.current, currentProblem.testCases, settings.language);
    setLastTestResults(results);
    lastTestResultsRef.current = results;
    setRunningTests(false);
    sendTurn({ latestEvent: "candidate just ran their code", candidateEntryText: null, audio: null });
  }

  // Auto-scroll the transcript. behavior "auto" — smooth would stutter at
  // typewriter frequency.
  const transcriptBoxRef = useRef(null);
  function scrollTranscriptToBottom() {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }
  useEffect(() => {
    scrollTranscriptToBottom();
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

  const phasePill = PHASE_PILLS[phase] || PHASE_PILLS.implementing;
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
      h(
        "div",
        { className: "topbar-center" },
        h(
          "span",
          { className: `phase-pill ${phasePill.className}` },
          phase === "reading" ? `${phasePill.label} · ${formatCountdown(readingSecondsLeft)}` : phasePill.label
        ),
        h("div", { className: `session-countdown${countdownClass}` }, formatCountdown(secondsLeft))
      ),
      h(
        "div",
        { className: "topbar-side topbar-right" },
        turnState === "speaking"
          ? h(
              "button",
              {
                className: `btn btn-small${agentPaused ? " toggle-on" : ""}`,
                onClick: handleTogglePause,
                "aria-pressed": agentPaused,
              },
              agentPaused ? "▶ Resume" : "⏸ Pause"
            )
          : h(
              "button",
              {
                className: "btn btn-small",
                onClick: handleReplayLast,
                disabled: !hasSpokenLine || turnState !== "idle" || !!errorBanner,
                title: "Replay the interviewer's last line",
              },
              "↺ Replay"
            ),
        voiceStatus !== "unavailable" &&
          h(
            "button",
            { className: "btn btn-small", onClick: handleToggleMute, "aria-pressed": muted, title: "Your microphone" },
            muted ? "🎙 Mic off" : "🎙 Mic on"
          ),
        h(
          "button",
          {
            className: "btn btn-small",
            onClick: handleToggleVoiceOver,
            "aria-pressed": !voiceOverOn,
            title: "The interviewer's voice",
          },
          voiceOverOn ? "🔊 Voice on" : "🔇 Voice off"
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
            noteCandidateActivity();
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
            getLevel: activeLevelSource,
            active: turnState === "speaking",
            frames: avatarFrames,
            videoSrc: avatarVideoSrc,
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
          turnState === "speaking" &&
            h("button", { className: "pill-skip", onClick: handleSkipSpeech, title: "Stop this reply's audio" }, "Skip ✕"),
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
              entry.role === "interviewer"
                ? h(TypedText, { text: entry.text, onGrow: scrollTranscriptToBottom, cps: voiceOverOn ? 15 : 40 })
                : h("span", { className: "entry-text" }, entry.text)
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
