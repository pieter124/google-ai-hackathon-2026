import { useState, h } from "./reactRuntime.js";
import { pickWeightedProblem } from "./config.js";
import { callGeminiScorecard } from "./api/geminiClient.js";
import { aggregateFillerStats } from "./utils/fillerWords.js";
import SetupScreen from "./components/SetupScreen.js";
import InterviewScreen from "./components/InterviewScreen.js";
import ScorecardScreen from "./components/ScorecardScreen.js";

const DEFAULT_SETTINGS = { interviewerId: "maya", language: "javascript", sessionLengthMinutes: 30 };

// Top-level view state machine. Everything is in-memory React state and
// resets on refresh.
export default function App() {
  const [view, setView] = useState("setup"); // setup | interview | generating-scorecard | scorecard
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const [currentProblem, setCurrentProblem] = useState(null);
  const [code, setCode] = useState("");
  const [lastTestResults, setLastTestResults] = useState([]);
  const [transcript, setTranscript] = useState([]);
  // Shared log the interviewer, aggregator and watchdog all append criteria
  // updates to; also drives the live CriteriaMatrix.
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
    setCode(problem.starterCode[settings.language] || problem.starterCode.javascript);
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
        language: settings.language,
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
    // Keep settings so "Practice again" remembers your interviewer and language.
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
        : h(
            "div",
            { className: "loading-stack" },
            h("div", { className: "spinner" }),
            h("p", { className: "spinner-label" }, "Generating your coaching scorecard...")
          )
    );
  }

  const fillerStats = aggregateFillerStats(transcript.filter((e) => e.role === "candidate").map((e) => e.text));
  return h(ScorecardScreen, {
    scorecard,
    problem: currentProblem,
    settings,
    lastTestResults,
    fillerStats,
    watchdogNudgeCount,
    onRestart: handleRestart,
  });
}
