// ---------------------------------------------------------------------------
// Single source of truth for the Google API key used by all three direct
// client calls (Gemini, Speech-to-Text, Text-to-Speech). No backend, so this
// key must be restricted (in Google Cloud Console) to exactly those 3 APIs
// and, ideally, to your demo's HTTP referrer.
// ---------------------------------------------------------------------------
export const GOOGLE_API_KEY = "PLACEHOLDER_API_KEY"; // replace with your own key, restricted to these 3 APIs

// Model used for every Gemini call (interview turns + scorecard). Kept as a
// single constant so it's a one-line change if the model name shown here
// ever gets deprecated in favor of a newer one.
export const GEMINI_MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Interviewer personas. `description` is what actually gets fed to Gemini as
// the persona instruction; `label` is what shows up in the setup dropdown.
// ---------------------------------------------------------------------------
export const PERSONAS = [
  {
    id: "tech-lead",
    label: "Technical Lead (skeptical, terse)",
    description:
      "a skeptical, terse technical lead. You speak in short sentences, rarely offer praise, and push hard on edge cases, correctness, and complexity. You expect the candidate to justify every design choice.",
  },
  {
    id: "hr-screener",
    label: "HR-style Screener (friendly, broad)",
    description:
      "a friendly, encouraging HR-style screener. You are warm and supportive, ask broad open-ended questions about approach and communication, and are less focused on deep technical rigor than on how the candidate thinks and communicates.",
  },
  {
    id: "hostile",
    label: "Hostile Stress-Tester (interrupts, pressure)",
    description:
      "a hostile stress-testing interviewer. You apply time pressure, interrupt with pointed challenges, question the candidate's assumptions aggressively, and rarely let a claim pass unchallenged.",
  },
  {
    id: "friendly-vague",
    label: "Friendly-but-vague (rambles, hard to read)",
    description:
      "a friendly but vague interviewer. You ramble, give meandering and indirect feedback, and are generally hard to read — it should often be unclear to the candidate whether you're satisfied or concerned.",
  },
];

// Auto-selected default persona for difficulties other than google-hard.
const DEFAULT_PERSONA_ID = "tech-lead";

// google-hard problems default to a terser, more pressuring persona than the
// candidate's dropdown pick would otherwise imply — unless they explicitly
// chose a specific persona (anything other than "Auto"), which always wins.
const BAR_RAISER_DESCRIPTION =
  "a terse, pressuring Google-style bar-raiser. You hold a very high bar, rarely offer reassurance, move quickly past small talk into complexity and edge cases, and expect the candidate to drive the conversation with minimal prompting from you.";

// Resolves the setup screen's persona choice (which may be "auto") plus the
// chosen problem's difficulty into the actual instruction text sent to
// Gemini as "this persona: {...}".
export function resolvePersonaDescription(settings, problem) {
  if (settings.persona !== "auto") {
    const picked = PERSONAS.find((p) => p.id === settings.persona);
    return picked ? picked.description : PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID).description;
  }
  if (problem && problem.difficulty === "google-hard") return BAR_RAISER_DESCRIPTION;
  return PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID).description;
}

export const PERSONA_OPTIONS = [
  { id: "auto", label: "Auto (recommended for difficulty)" },
  ...PERSONAS.map((p) => ({ id: p.id, label: p.label })),
];

export const DIFFICULTY_OPTIONS = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "google-hard", label: "Google Hard" },
];

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
