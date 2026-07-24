import { useState, h } from "./reactRuntime.js";
import { PROBLEM_BANK } from "./config.js";
import { callGeminiScorecard } from "./api/geminiClient.js";
import SetupScreen from "./components/SetupScreen.js";
import InterviewScreen from "./components/InterviewScreen.js";
import ScorecardScreen from "./components/ScorecardScreen.js";

const DEFAULT_SETTINGS = { difficulty: "easy", persona: "auto" };

// Top-level state machine. Everything here is plain React state — per the
// hard constraints, nothing persists across a refresh and there is no
// backend/database backing any of it.
export default function App() {
  const [view, setView] = useState("setup"); // setup | interview | generating-scorecard | scorecard
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  const [currentProblem, setCurrentProblem] = useState(null);
  const [code, setCode] = useState("");
  const [lastTestResults, setLastTestResults] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [interviewerImpressions, setInterviewerImpressions] = useState(""); // never shown to the candidate
  const [hintsUsed, setHintsUsed] = useState(0);
  const [scorecard, setScorecard] = useState(null);
  const [scorecardError, setScorecardError] = useState(null);

  function handleChangeSettings(partial) {
    setSettings((prev) => ({ ...prev, ...partial }));
  }

  function handleStart() {
    const pool = PROBLEM_BANK.filter((p) => p.difficulty === settings.difficulty);
    const problem = pool[Math.floor(Math.random() * pool.length)];
    setCurrentProblem(problem);
    setCode(problem.starterCode);
    setLastTestResults([]);
    setTranscript([]);
    setInterviewerImpressions("");
    setHintsUsed(0);
    setScorecard(null);
    setScorecardError(null);
    setView("interview");
  }

  async function generateScorecard(finalHintsUsed) {
    setView("generating-scorecard");
    setScorecardError(null);
    try {
      const result = await callGeminiScorecard({
        currentProblem,
        code,
        lastTestResults,
        transcript,
        interviewerImpressions,
        hintsUsed: finalHintsUsed,
      });
      setScorecard({ ...result, hintsUsed: finalHintsUsed });
      setView("scorecard");
    } catch (err) {
      setScorecardError({ message: err.message, retry: () => generateScorecard(finalHintsUsed) });
    }
  }

  function handleWrapUp() {
    generateScorecard(hintsUsed);
  }

  function handleRestart() {
    setView("setup");
    setSettings(DEFAULT_SETTINGS);
    setCurrentProblem(null);
    setCode("");
    setLastTestResults([]);
    setTranscript([]);
    setInterviewerImpressions("");
    setHintsUsed(0);
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
      interviewerImpressions,
      setInterviewerImpressions,
      hintsUsed,
      setHintsUsed,
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

  return h(ScorecardScreen, { scorecard, lastTestResults, onRestart: handleRestart });
}
