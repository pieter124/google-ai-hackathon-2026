import { useState, h } from "./reactRuntime.js";
import { pickWeightedProblem } from "./utils/weightedRandom.js";
import { callGeminiReport } from "./api/geminiClient.js";
import SetupScreen from "./components/SetupScreen.js";
import InterviewScreen from "./components/InterviewScreen.js";
import ScorecardScreen from "./components/ScorecardScreen.js";

// interviewerId picks the persona + voice; language picks the editor + runner;
// the problem itself is rolled by the weighted randomizer. Length in minutes.
const DEFAULT_SETTINGS = { interviewerId: "maya", language: "javascript", sessionLength: 30 };

// Top-level state machine. Everything is plain React state — per the hard
// constraints nothing persists across a refresh and there is no backend.
export default function App() {
  const [view, setView] = useState("setup"); // setup | interview | generating-report | scorecard
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Problem is chosen on the setup screen (via the Randomize button) so the
  // candidate sees what they're about to get and can reroll before starting.
  const [problem, setProblem] = useState(() => pickWeightedProblem());

  const [code, setCode] = useState("");
  const [lastTestResults, setLastTestResults] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [scorecard, setScorecard] = useState(null);
  const [reportError, setReportError] = useState(null);

  function handleChangeSettings(partial) {
    setSettings((prev) => ({ ...prev, ...partial }));
  }

  // Reroll to a different problem (weighted, never the current one).
  function handleRandomize() {
    setProblem((prev) => pickWeightedProblem(prev?.id));
  }

  function handleStart() {
    setCode(problem.starterCode[settings.language] || problem.starterCode.javascript);
    setLastTestResults([]);
    setTranscript([]);
    setHintsUsed(0);
    setScorecard(null);
    setReportError(null);
    setView("interview");
  }

  // The interview screen owns the session log and hands up the derived signals
  // (path trajectory, checkpoint notes, filler stats) that the report merges
  // with the transcript/code/impressions App already holds.
  async function generateReport(analysis) {
    setView("generating-report");
    setReportError(null);
    try {
      const result = await callGeminiReport({
        currentProblem: problem,
        code,
        lastTestResults,
        transcript,
        criteriaLog: analysis.criteriaLog,
        hintsUsed: analysis.hintsUsed,
        fillerStats: analysis.fillerStats,
        progressSeries: analysis.progressSeries,
        checkpointNotes: analysis.checkpointNotes,
      });
      setScorecard(result);
      setView("scorecard");
    } catch (err) {
      setReportError({ message: err.message, retry: () => generateReport(analysis) });
    }
  }

  function handleRestart() {
    setSettings(DEFAULT_SETTINGS);
    setProblem(pickWeightedProblem());
    setCode("");
    setLastTestResults([]);
    setTranscript([]);
    setHintsUsed(0);
    setScorecard(null);
    setReportError(null);
    setView("setup");
  }

  if (view === "setup") {
    return h(SetupScreen, {
      settings,
      problem,
      onChangeSettings: handleChangeSettings,
      onRandomize: handleRandomize,
      onStart: handleStart,
    });
  }

  if (view === "interview") {
    return h(InterviewScreen, {
      currentProblem: problem,
      settings,
      code,
      setCode,
      lastTestResults,
      setLastTestResults,
      transcript,
      setTranscript,
      hintsUsed,
      setHintsUsed,
      onWrapUp: generateReport,
    });
  }

  if (view === "generating-report") {
    return h(
      "div",
      { className: "screen loading-screen" },
      reportError
        ? h(
            "div",
            { className: "error-banner" },
            h("span", null, `⚠️ Couldn't generate the report: ${reportError.message}`),
            h("button", { className: "btn btn-small", onClick: reportError.retry }, "Retry")
          )
        : h("p", { className: "spinner-label" }, "Scoring your interview...")
    );
  }

  return h(ScorecardScreen, { scorecard, lastTestResults, onRestart: handleRestart });
}
