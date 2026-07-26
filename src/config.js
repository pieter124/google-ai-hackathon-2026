// ===========================================================================
// Single source of truth for tunable constants: API access, personas,
// difficulty, the problem bank, the scoring rubric, and the timing thresholds
// that drive the Aggregator and Watchdog agents. Everything a demo-runner
// might want to tweak lives here so no behavior is buried in a component.
// ===========================================================================

// --- Google API key --------------------------------------------------------
// No backend exists, so the key ships client-side. We read it from
// localStorage FIRST (set once in devtools: `localStorage.GOOGLE_API_KEY='...'`)
// and only fall back to the in-file placeholder. Rationale: this repo is
// shared and pushed to a branch — a real key must never be committed. The key
// must be restricted (Google Cloud Console) to exactly the 3 APIs used here
// (Gemini, Speech-to-Text, Text-to-Speech) and ideally to the demo referrer.
const PLACEHOLDER_API_KEY = "PLACEHOLDER_API_KEY";
export function getApiKey() {
  try {
    const stored = localStorage.getItem("GOOGLE_API_KEY");
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* localStorage can throw in locked-down browser contexts; ignore */
  }
  return PLACEHOLDER_API_KEY;
}
export const IS_API_KEY_SET = () => getApiKey() !== PLACEHOLDER_API_KEY;

// Model used for every Gemini call. Single constant = one-line change if the
// model name is ever deprecated.
export const GEMINI_MODEL = "gemini-2.5-flash";

// Optional looped avatar video shown in the top-right during the interview.
// Drop a muted, seamless loop (e.g. a talking-head render) at this path and it
// takes over from the animated orb automatically. Left null so there's no
// broken-media icon until an asset exists.
export const AVATAR_VIDEO_SRC = null; // e.g. "./assets/avatar.webm"

// ---------------------------------------------------------------------------
// Interviewer difficulty. The candidate picks ONE of these on the setup
// screen (the "difficulty of the interviewer"). Each maps to a persona
// instruction fed into every Agent-1 turn plus a hint posture the Watchdog
// and per-turn prompt both respect. Two tiers on purpose — a supportive one
// and a rigorous one — because that is the single dial candidates actually
// reason about ("go easy on me" vs "grill me").
// ---------------------------------------------------------------------------
// Four named interviewers (ported from the team's `main` branch). Each is a
// persona fed to Gemini plus the presentation the candidate picks: a name, a
// title, a one-line blurb, a Cloud TTS voice (passed straight into our
// textToSpeech call, so each interviewer literally sounds different), and a
// `hintPosture` the Watchdog and per-turn prompt both respect. The
// easy↔hard dial the candidate reasons about now lives in the persona's tone:
// Maya is the "easy" end, the other three raise the bar.
export const INTERVIEWERS = [
  {
    id: "maya",
    name: "Maya Chen",
    title: "Senior Software Engineer",
    blurb: "Warm · gives you room to think · easy",
    voiceName: "en-US-Neural2-F",
    hintPosture: "generous",
    description:
      "a supportive, encouraging interviewer named Maya Chen, a Senior Software Engineer. You give the candidate room to think out loud, offer warmth when they're stuck, and favor escalating, non-bottom-out hints — start vague, and only get more concrete if they're still stuck after trying.",
  },
  {
    id: "victor",
    name: "Victor Osei",
    title: "Staff Engineer",
    blurb: "High bar · edge cases · few pleasantries",
    voiceName: "en-US-Neural2-J",
    hintPosture: "sparing",
    description:
      "a rigorous, high-bar interviewer named Victor Osei, a Staff Engineer. You push on edge cases, correctness, and complexity, rarely offer reassurance, and expect the candidate to drive — but still give escalating, non-bottom-out hints rather than the full solution when they're stuck.",
  },
  {
    id: "priya",
    name: "Priya Raghavan",
    title: "Engineering Manager",
    blurb: "Pragmatic · cares about trade-offs & clarity",
    voiceName: "en-US-Neural2-C",
    hintPosture: "sparing",
    description:
      "a pragmatic, direct interviewer named Priya Raghavan, an Engineering Manager. You care most about clear trade-off reasoning and structured communication: you interrupt rambling politely, ask 'why this approach over the alternative?', and expect the candidate to state assumptions and complexity unprompted. Hints are brief and Socratic, never the answer.",
  },
  {
    id: "erik",
    name: "Erik Lindqvist",
    title: "Principal Engineer",
    blurb: "Calm pressure · silence · 'what breaks at scale?'",
    voiceName: "en-US-Studio-Q",
    hintPosture: "sparing",
    description:
      "a calm but intense interviewer named Erik Lindqvist, a Principal Engineer known for pressure-testing candidates. You speak sparingly, let silences hang, and follow nearly every answer with a harder follow-up: scale limits, failure modes, pathological inputs. You are fair but skeptical by default, and your hints are the smallest possible push — never more.",
  },
];

export function resolveInterviewer(id) {
  return INTERVIEWERS.find((p) => p.id === id) || INTERVIEWERS[0];
}

// Editor languages — both run entirely client-side: JavaScript in a Web
// Worker (utils/sandbox.js), Python via a Pyodide worker (utils/pythonRunner.js).
export const LANGUAGE_OPTIONS = [
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

// ---------------------------------------------------------------------------
// Session length options (minutes). Stored as minutes here; converted to ms
// at the timer. 30/45 mirror a real phone-screen / onsite slot.
// ---------------------------------------------------------------------------
export const SESSION_LENGTHS = [
  { id: 30, label: "30 min" },
  { id: 45, label: "45 min" },
];

// ---------------------------------------------------------------------------
// Problem-selection weights. The candidate's request: problems should be
// "medium minimum" — so easy is weight 0 (still in the bank for reference, but
// the randomizer never rolls it). Medium is the floor, hard/google-hard are
// well represented. Tune here without touching the picker logic.
// ---------------------------------------------------------------------------
export const DIFFICULTY_WEIGHTS = {
  easy: 0,
  medium: 50,
  hard: 30,
  "google-hard": 20,
};

// ---------------------------------------------------------------------------
// Agent 2 (Aggregator) + Agent 3 (Watchdog) timing. Placeholder values here
// are UI-adapted starting points; the two research passes refine the numbers.
// All in milliseconds.
// ---------------------------------------------------------------------------
export const AGGREGATOR_INTERVAL_MS = 120000; // windowed analysis every ~2 min (short enough that a demo shows at least one checkpoint)

// Thresholds below are research-adapted (wait-time, ITS idle, assistance-
// dilemma literature): protect think-time, treat silence as productive while
// typing/narrating, and require a sustained stuck pattern before stepping in.
// See RESEARCH.md for citations.
export const WATCHDOG = {
  checkEveryMs: 3000, // re-evaluate heuristics every 3s (also the keystroke-snapshot cadence)
  silentIdleMs: 35000, // no typing AND no turn sent this long → intervene (30-45s "hard idle" band; below this is protected think-time)
  fillerRatioThreshold: 0.28, // filler fraction in recent speech that reads as "talking without progress"
  minCooldownMs: 75000, // one nudge per ~75s max (research: ~60-90s between hint-ladder steps), so it can't spam
};

// ---------------------------------------------------------------------------
// Scoring rubric. Each dimension is scored 1-5 by the end-of-session report
// call. Anchors are deliberately concrete so the LLM scorer is consistent.
// These are placeholders pending the evaluation-criteria research pass; the
// dimension SET is stable, the anchor wording will be tightened from sources.
// ---------------------------------------------------------------------------
// Anchors are the intersection of Google's four attributes, Meta's four
// signals, and the ML-system-design dimensions, written for an LLM scorer
// (Naim et al. 2018; "Rubric Is All You Need," ICER 2025). See RESEARCH.md.
// Communication is intended as a CAP, not an additive — a strong coder the
// interviewer can't follow is a real-world reject; the report prompt enforces
// that.
export const RUBRIC = [
  {
    id: "problemSolving",
    label: "Problem-solving & approach",
    definition: "Decodes an ambiguous problem, structures an approach, and iterates toward a correct/optimal solution.",
    anchors: {
      1: "No coherent plan; never reaches a viable path even with heavy hints",
      3: "Reaches a working approach, but only after prompting; misses obvious sub-cases",
      5: "Independently clarifies, decomposes, weighs multiple approaches, drives to the optimal one with no substantive hints",
    },
  },
  {
    id: "coding",
    label: "Coding & correctness",
    definition: "Translates the approach into correct, clean, idiomatic code that passes the tests.",
    anchors: {
      1: "Major logic/syntax errors; code doesn't run or is fundamentally wrong",
      3: "Mostly working with minor bugs; not clean/idiomatic",
      5: "Clean, correct, idiomatic; handles edge cases",
    },
  },
  {
    id: "communication",
    label: "Communication",
    definition: "Whether the interviewer can follow the reasoning in real time, and how well feedback is incorporated.",
    anchors: {
      1: "Interviewer can't follow; silent/disorganized; ignores hints",
      3: "Followable with effort; explains after the fact; integrates hints slowly",
      5: "Narrates while working, asks sharp clarifying questions up front, explicitly uses feedback",
    },
  },
  {
    id: "verification",
    label: "Verification & testing",
    definition: "Proactively tests the solution and reasons about edge cases and failure modes.",
    anchors: {
      1: "No testing; ignores edge cases",
      3: "Tests the happy path when prompted; catches some edge cases",
      5: "Self-verifies unprompted; walks edge cases as a habit",
    },
  },
  {
    id: "complexity",
    label: "Complexity & trade-offs",
    definition: "Reasons about time/space complexity and compares design trade-offs.",
    anchors: {
      1: "Can't state complexity; unaware of trade-offs",
      3: "States correct big-O when asked; sees one trade-off",
      5: "Proactively analyzes complexity, compares alternatives, optimizes with justification",
    },
  },
];

// ---------------------------------------------------------------------------
// Curated problem bank — hardcoded on purpose (no AI-generated problems).
// Every problem exposes a single `solve` function so the sandbox runner and
// test-case format stay identical across difficulties.
// ---------------------------------------------------------------------------
export const PROBLEM_BANK = [
  {
    id: "two-sum",
    difficulty: "easy",
    title: "Two Sum",
    description:
      "Given an array of integers nums and an integer target, return indices of the two numbers that add up to target. Assume exactly one solution exists, and you may not use the same element twice.",
    functionName: "solve",
    starterCode: { javascript: "function solve(nums, target) {\n  \n}", python: "def solve(nums, target):\n    pass\n" },
    testCases: [
      { input: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { input: [[3, 2, 4], 6], expected: [1, 2] },
      { input: [[3, 3], 6], expected: [0, 1] },
    ],
  },
  {
    id: "valid-parentheses",
    difficulty: "easy",
    title: "Valid Parentheses",
    description:
      "Given a string s containing just the characters '(', ')', '{', '}', '[' and ']', determine if the input string is valid: every open bracket must be closed by the same type of bracket, and in the correct order.",
    functionName: "solve",
    starterCode: { javascript: "function solve(s) {\n  \n}", python: "def solve(s):\n    pass\n" },
    testCases: [
      { input: ["()[]{}"], expected: true },
      { input: ["(]"], expected: false },
      { input: ["{[]}"], expected: true },
      { input: ["("], expected: false },
    ],
  },
  {
    id: "longest-substring-no-repeat",
    difficulty: "medium",
    title: "Longest Substring Without Repeating Characters",
    description:
      "Given a string s, return the length of the longest substring of s without repeating characters.",
    functionName: "solve",
    starterCode: { javascript: "function solve(s) {\n  \n}", python: "def solve(s):\n    pass\n" },
    testCases: [
      { input: ["abcabcbb"], expected: 3 },
      { input: ["bbbbb"], expected: 1 },
      { input: ["pwwkew"], expected: 3 },
      { input: [""], expected: 0 },
    ],
  },
  {
    id: "product-except-self",
    difficulty: "medium",
    title: "Product of Array Except Self",
    description:
      "Given an integer array nums, return an array answer such that answer[i] is equal to the product of all elements of nums except nums[i]. Do this without using the division operator, in O(n) time.",
    functionName: "solve",
    starterCode: { javascript: "function solve(nums) {\n  \n}", python: "def solve(nums):\n    pass\n" },
    testCases: [
      { input: [[1, 2, 3, 4]], expected: [24, 12, 8, 6] },
      { input: [[-1, 1, 0, -3, 3]], expected: [0, 0, 9, 0, 0] },
    ],
  },
  {
    id: "trapping-rain-water",
    difficulty: "hard",
    title: "Trapping Rain Water",
    description:
      "Given n non-negative integers representing an elevation map where the width of each bar is 1, compute how much water it can trap after raining.",
    functionName: "solve",
    starterCode: { javascript: "function solve(height) {\n  \n}", python: "def solve(height):\n    pass\n" },
    testCases: [
      { input: [[0, 1, 0, 2, 1, 0, 1, 3, 2, 1, 2, 1]], expected: 6 },
      { input: [[4, 2, 0, 3, 2, 5]], expected: 9 },
      { input: [[]], expected: 0 },
    ],
  },
  {
    id: "median-two-sorted-arrays",
    difficulty: "hard",
    title: "Median of Two Sorted Arrays",
    description:
      "Given two sorted arrays nums1 and nums2 of size m and n respectively, return the median of the two sorted arrays. Aim for O(log(m+n)) time.",
    functionName: "solve",
    starterCode: { javascript: "function solve(nums1, nums2) {\n  \n}", python: "def solve(nums1, nums2):\n    pass\n" },
    testCases: [
      { input: [[1, 3], [2]], expected: 2 },
      { input: [[1, 2], [3, 4]], expected: 2.5 },
      { input: [[0, 0], [0, 0]], expected: 0 },
    ],
  },
  {
    id: "word-break",
    difficulty: "google-hard",
    title: "Word Break",
    description:
      "Given a string s and a dictionary of strings wordDict, return true if s can be segmented into a space-separated sequence of one or more dictionary words.",
    functionName: "solve",
    starterCode: { javascript: "function solve(s, wordDict) {\n  \n}", python: "def solve(s, wordDict):\n    pass\n" },
    testCases: [
      { input: ["leetcode", ["leet", "code"]], expected: true },
      { input: ["applepenapple", ["apple", "pen"]], expected: true },
      { input: ["catsandog", ["cats", "dog", "sand", "and", "cat"]], expected: false },
    ],
  },
  {
    id: "course-schedule",
    difficulty: "google-hard",
    title: "Course Schedule",
    description:
      "There are numCourses courses labeled 0 to numCourses-1. You are given an array prerequisites where prerequisites[i] = [a, b] means you must take course b before course a. Return true if it's possible to finish all courses (i.e. the prerequisite graph has no cycle).",
    functionName: "solve",
    starterCode: { javascript: "function solve(numCourses, prerequisites) {\n  \n}", python: "def solve(numCourses, prerequisites):\n    pass\n" },
    testCases: [
      { input: [2, [[1, 0]]], expected: true },
      { input: [2, [[1, 0], [0, 1]]], expected: false },
      { input: [4, [[1, 0], [2, 0], [3, 1], [3, 2]]], expected: true },
    ],
  },
];
