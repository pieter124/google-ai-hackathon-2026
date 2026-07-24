import { useState, h } from "./reactRuntime.js";
import { pickWeightedProblem } from "./config.js";
import { callGeminiScorecard } from "./api/geminiClient.js";
import { aggregateFillerStats } from "./utils/fillerWords.js";
import SetupScreen from "./components/SetupScreen.js";
import InterviewScreen from "./components/InterviewScreen.js";
import ScorecardScreen from "./components/ScorecardScreen.js";

const DEFAULT_SETTINGS = { persona: "supportive", sessionLengthMinutes: 30 };

// Top-level state machine. Everything here is plain React state — per the
// hard constraints, nothing persists across a refresh and there is no
// database backing any of it (the only server involved is the same-origin
// ADC-authenticated proxy in server/server.js, which holds no session state
// of its own).
export default function App() {
  const [view, setView] = useState("setup"); // setup | interview | generating-scorecard | scorecard
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const [currentProblem, setCurrentProblem] = useState(null);
  const [code, setCode] = useState("");
  const [lastTestResults, setLastTestResults] = useState([]);
  const [transcript, setTranscript] = useState([]);
  // Shared session log the three agents all write into: per-turn updates
  // (Agent 1), periodic checkpoint updates (Agent 2), and watchdog nudges
  // (Agent 3) each append { timestamp, source, criteriaUpdate }. Unlike the
  // old hidden "interviewerImpressions" this replaces, it's shown live to
  // the candidate via CriteriaMatrix.
  const [criteriaLog, setCriteriaLog] = useState([]);
  const [watchdogNudgeCount, setWatchdogNudgeCount] = useState(0);
  const [scorecard, setScorecard] = useState(null);
  const [scorecardError, setScorecardError] = useState(null);

  function handleChangeSettings(partial) {
    setSettings((prev) => ({ ...prev, ...partial }));
  }

  function handleStart() {
    const problem = pickWeightedProblem();
    setCurrentProblem(problem);
    setCode(problem.starterCode);
    setLastTestResults([]);
    setTranscript([]);
    setCriteriaLog([]);
    setWatchdogNudgeCount(0);
    setScorecard(null);
    setScorecardError(null);
    setView("interview");
  }

  async function generateScorecard(finalWatchdogNudgeCount) {
    setView("generating-scorecard");
    setScorecardError(null);
    try {
      const fillerStats = aggregateFillerStats(transcript.filter((e) => e.role === "candidate").map((e) => e.text));
      const result = await callGeminiScorecard({
        currentProblem,
        code,
        lastTestResults,
        transcript,
        criteriaLog,
        fillerStats,
        watchdogNudgeCount: finalWatchdogNudgeCount,
      });
      setScorecard(result);
      setView("scorecard");
    } catch (err) {
      setScorecardError({ message: err.message, retry: () => generateScorecard(finalWatchdogNudgeCount) });
    }
  }

  function handleWrapUp() {
    generateScorecard(watchdogNudgeCount);
  }

  function handleRestart() {
    setView("setup");
    setSettings(DEFAULT_SETTINGS);
    setCurrentProblem(null);
    setCode("");
    setLastTestResults([]);
    setTranscript([]);
    setCriteriaLog([]);
    setWatchdogNudgeCount(0);
    setScorecard(null);
    setScorecardError(null);
  }

  if (view === "setup") {
    return h(SetupScreen, { settings, onChangeSettings: handleChangeSettings, onStart: handleStart });
  }

  if (view === "interview") {
    return h(InterviewScreen, {
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
      onWrapUp: handleWrapUp,
    });
  }

  if (view === "generating-scorecard") {
    return h(
      "div",
      { className: "screen loading-screen" },
      scorecardError
        ? h(
            "div",
            { className: "error-banner" },
            h("span", null, `⚠️ Couldn't generate the scorecard: ${scorecardError.message}`),
            h("button", { className: "btn btn-small", onClick: scorecardError.retry }, "Retry")
          )
        : h("p", { className: "spinner-label" }, "Generating your coaching scorecard...")
    );
  }

  const fillerStats = aggregateFillerStats(transcript.filter((e) => e.role === "candidate").map((e) => e.text));
  return h(ScorecardScreen, {
    scorecard,
    lastTestResults,
    fillerStats,
    watchdogNudgeCount,
    onRestart: handleRestart,
  });
}
