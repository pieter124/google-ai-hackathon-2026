import { pickWeighted } from "./utils/weightedRandom.js";

// ---------------------------------------------------------------------------
// Every Google call (Gemini reasoning, Gemini native audio-out, and the
// Speech-to-Text fallback used only when Gemini's audio-understanding input
// rejects the browser's recording format) goes through this app's own
// backend (server/server.js) instead of straight to Google. The server
// authenticates upstream via Application Default Credentials, so no API key
// lives in client-side source anymore — the model names below are just
// passed through to tell the backend which model to call.
// ---------------------------------------------------------------------------

// Model used for reasoning calls (interview turns, checkpoints, scorecard).
export const GEMINI_MODEL = "gemini-3.6-flash";

// ---------------------------------------------------------------------------
// Interviewer personas — the "difficulty persona" dial from the spec.
// `description` is what actually gets fed to Gemini as the persona
// instruction; `label` is what shows up in the setup dropdown.
// ---------------------------------------------------------------------------
export const PERSONAS = [
  {
    id: "supportive",
    label: "Supportive",
    description:
      "a supportive, encouraging interviewer. You give the candidate room to think out loud, offer warmth when they're stuck, and favor escalating, non-bottom-out hints — start vague, and only get more concrete if they're still stuck after trying.",
  },
  {
    id: "rigorous",
    label: "Rigorous",
    description:
      "a rigorous, high-bar interviewer. You push on edge cases, correctness, and complexity, rarely offer reassurance, and expect the candidate to drive the conversation — but still give escalating, non-bottom-out hints rather than the full solution when they're stuck.",
  },
];

export function getPersonaDescription(personaId) {
  const picked = PERSONAS.find((p) => p.id === personaId);
  return picked ? picked.description : PERSONAS[0].description;
}

export const PERSONA_OPTIONS = PERSONAS.map((p) => ({ id: p.id, label: p.label }));

export const SESSION_LENGTH_OPTIONS = [
  { id: 30, label: "30 minutes" },
  { id: 45, label: "45 minutes" },
];

// ---------------------------------------------------------------------------
// Live criteria matrix — the single schema shared by: the visible on-screen
// panel, every Gemini prompt that can update criteria (per-turn, checkpoint,
// watchdog nudge), and the final report's per-criterion scores.
// ---------------------------------------------------------------------------
export const CRITERIA_DEFINITIONS = [
  { id: "problemUnderstanding", label: "Problem Understanding" },
  { id: "communication", label: "Communication & Approach" },
  { id: "codeQuality", label: "Code Quality & Correctness" },
  { id: "complexityAwareness", label: "Complexity Awareness" },
];

// ---------------------------------------------------------------------------
// Weighted randomizer for problem selection: ~10% easy / ~45% medium / ~45%
// hard. The two curated "google-hard" problems keep their own badge/label for
// display, but fold into the "hard" weight's candidate pool — there's no
// longer a difficulty dropdown or a difficulty-linked persona override to
// hang a separate tier off of.
// ---------------------------------------------------------------------------
export const DIFFICULTY_WEIGHTS = [
  { difficulty: "easy", weight: 10 },
  { difficulty: "medium", weight: 45 },
  { difficulty: "hard", weight: 45 },
];

function poolForDifficulty(tier) {
  if (tier === "hard") return PROBLEM_BANK.filter((p) => p.difficulty === "hard" || p.difficulty === "google-hard");
  return PROBLEM_BANK.filter((p) => p.difficulty === tier);
}

// Picks a difficulty tier by weight, then a random problem from that tier's
// pool. Exported separately from the pure `pickWeighted` utility so callers
// don't need to know about the google-hard folding rule above.
export function pickWeightedProblem() {
  const tier = pickWeighted(DIFFICULTY_WEIGHTS).difficulty;
  const pool = poolForDifficulty(tier);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// Curated problem bank — hardcoded on purpose (no AI-generated problems).
// Every problem exposes a single `solve` function so the sandbox runner and
// test-case format can stay identical across difficulties.
// ---------------------------------------------------------------------------
export const PROBLEM_BANK = [
  {
    id: "two-sum",
    difficulty: "easy",
    title: "Two Sum",
    description:
      "Given an array of integers nums and an integer target, return indices of the two numbers that add up to target. Assume exactly one solution exists, and you may not use the same element twice.",
    functionName: "solve",
    starterCode: "function solve(nums, target) {\n  \n}",
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
    starterCode: "function solve(s) {\n  \n}",
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
    starterCode: "function solve(s) {\n  \n}",
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
    starterCode: "function solve(nums) {\n  \n}",
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
    starterCode: "function solve(height) {\n  \n}",
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
    starterCode: "function solve(nums1, nums2) {\n  \n}",
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
    starterCode: "function solve(s, wordDict) {\n  \n}",
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
    starterCode: "function solve(numCourses, prerequisites) {\n  \n}",
    testCases: [
      { input: [2, [[1, 0]]], expected: true },
      { input: [2, [[1, 0], [0, 1]]], expected: false },
      { input: [4, [[1, 0], [2, 0], [3, 1], [3, 2]]], expected: true },
    ],
  },
];
