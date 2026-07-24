import { pickWeighted } from "./utils/weightedRandom.js";

// ---------------------------------------------------------------------------
// Every Google call (Gemini reasoning, Gemini avatar image generation, and
// the Speech-to-Text fallback used only when Gemini's audio-understanding
// input rejects the browser's recording format) goes through this app's own
// backend (server/server.js) instead of straight to Google. The server
// authenticates upstream via an API key or Application Default Credentials,
// so no credential lives in client-side source — the model names below are
// just passed through to tell the backend which model to call.
// ---------------------------------------------------------------------------

// Model used for reasoning calls (interview turns, checkpoints, scorecard).
export const GEMINI_MODEL = "gemini-3.6-flash";

// Model used once per interviewer character to generate their avatar
// portrait (cached in localStorage after the first successful generation).
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

// ---------------------------------------------------------------------------
// Interviewer characters — each one is a persona (fed to Gemini as the
// interviewer instruction) plus the presentation the candidate sees: a name,
// a title, a Cloud TTS voice, and a prompt used to generate their avatar
// portrait. All portraits share the same art direction so the setup grid
// looks like one cast. Voices: Neural2 is Google's natural-sounding tier;
// Erik gets a Studio voice (Cloud TTS's premium tier, most authoritative).
// ---------------------------------------------------------------------------
const AVATAR_STYLE =
  "Flat vector illustration, minimal modern style, clean geometric shapes, centered head-and-shoulders portrait, " +
  "solid dark navy background, soft studio lighting, no text, no watermark.";

export const INTERVIEWERS = [
  {
    id: "maya",
    name: "Maya Chen",
    title: "Senior Software Engineer",
    blurb: "Warm and encouraging — gives you room to think out loud.",
    voiceName: "en-US-Neural2-F",
    description:
      "a supportive, encouraging interviewer named Maya Chen, a Senior Software Engineer. You give the candidate room to think out loud, offer warmth when they're stuck, and favor escalating, non-bottom-out hints — start vague, and only get more concrete if they're still stuck after trying.",
    avatarPrompt:
      `Portrait avatar of a friendly East Asian woman in her early 30s, software engineer, shoulder-length dark hair, warm confident smile, teal blouse. ${AVATAR_STYLE}`,
  },
  {
    id: "victor",
    name: "Victor Osei",
    title: "Staff Engineer",
    blurb: "High bar, few pleasantries — pushes on edge cases and complexity.",
    voiceName: "en-US-Neural2-J",
    description:
      "a rigorous, high-bar interviewer named Victor Osei, a Staff Engineer. You push on edge cases, correctness, and complexity, rarely offer reassurance, and expect the candidate to drive the conversation — but still give escalating, non-bottom-out hints rather than the full solution when they're stuck.",
    avatarPrompt:
      `Portrait avatar of a serious Black man in his late 30s, staff software engineer, short hair, neat beard, glasses, charcoal shirt, composed expression. ${AVATAR_STYLE}`,
  },
  {
    id: "priya",
    name: "Priya Raghavan",
    title: "Engineering Manager",
    blurb: "Pragmatic and direct — cares about trade-offs and clean reasoning.",
    voiceName: "en-US-Neural2-C",
    description:
      "a pragmatic, direct interviewer named Priya Raghavan, an Engineering Manager. You care most about clear trade-off reasoning and structured communication: you interrupt rambling politely, ask 'why this approach over the alternative?', and expect the candidate to state assumptions and complexity unprompted. Hints are brief and Socratic, never the answer.",
    avatarPrompt:
      `Portrait avatar of a professional South Asian woman in her 40s, engineering manager, tied-back dark hair, subtle earrings, deep plum blazer, attentive neutral expression. ${AVATAR_STYLE}`,
  },
  {
    id: "erik",
    name: "Erik Lindqvist",
    title: "Principal Engineer",
    blurb: "Calm pressure — silence, follow-ups, and 'what breaks at scale?'",
    voiceName: "en-US-Studio-Q",
    description:
      "a calm but intense interviewer named Erik Lindqvist, a Principal Engineer known for pressure-testing candidates. You speak sparingly, let silences hang, and follow nearly every answer with a harder follow-up: scale limits, failure modes, pathological inputs. You are fair but skeptical by default, and your hints are the smallest possible push — never more.",
    avatarPrompt:
      `Portrait avatar of a Scandinavian man in his 50s, principal engineer, short grey-blond hair, light stubble, steel-blue sweater, calm penetrating gaze. ${AVATAR_STYLE}`,
  },
];

export function getInterviewer(id) {
  return INTERVIEWERS.find((p) => p.id === id) || INTERVIEWERS[0];
}

// ---------------------------------------------------------------------------
// Editor languages. Both are runnable: JavaScript in the existing Web Worker
// sandbox, Python via a Pyodide worker (see utils/pythonRunner.js).
// ---------------------------------------------------------------------------
export const LANGUAGE_OPTIONS = [
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
];

export const SESSION_LENGTH_OPTIONS = [
  { id: 30, label: "30 min" },
  { id: 45, label: "45 min" },
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
// display, but fold into the "hard" weight's candidate pool.
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
// Every problem exposes a single `solve` entry point in each language so the
// sandbox runners and test-case format stay identical across difficulties.
// `examples` and `constraints` are rendered LeetCode-style in the problem
// panel and included in the interviewer's prompt context.
// ---------------------------------------------------------------------------
export const PROBLEM_BANK = [
  {
    id: "two-sum",
    difficulty: "easy",
    title: "Two Sum",
    description:
      "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target. You may assume that each input has exactly one solution, and you may not use the same element twice. You can return the answer in any order.",
    examples: [
      {
        input: "nums = [2,7,11,15], target = 9",
        output: "[0,1]",
        explanation: "Because nums[0] + nums[1] == 9, we return [0, 1].",
      },
      { input: "nums = [3,2,4], target = 6", output: "[1,2]" },
      { input: "nums = [3,3], target = 6", output: "[0,1]" },
    ],
    constraints: [
      "2 <= nums.length <= 10^4",
      "-10^9 <= nums[i] <= 10^9",
      "-10^9 <= target <= 10^9",
      "Only one valid answer exists.",
    ],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(nums, target) {\n  \n}",
      python: "def solve(nums, target):\n    pass\n",
    },
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
      "Given a string s containing just the characters '(', ')', '{', '}', '[' and ']', determine if the input string is valid. An input string is valid if open brackets are closed by the same type of brackets, open brackets are closed in the correct order, and every close bracket has a corresponding open bracket of the same type.",
    examples: [
      { input: 's = "()[]{}"', output: "true" },
      { input: 's = "(]"', output: "false" },
      { input: 's = "{[]}"', output: "true" },
    ],
    constraints: ["1 <= s.length <= 10^4", "s consists of parentheses only: '()[]{}'."],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(s) {\n  \n}",
      python: "def solve(s):\n    pass\n",
    },
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
    description: "Given a string s, find the length of the longest substring without duplicate characters.",
    examples: [
      {
        input: 's = "abcabcbb"',
        output: "3",
        explanation: 'The answer is "abc", with a length of 3.',
      },
      { input: 's = "bbbbb"', output: "1", explanation: 'The answer is "b", with a length of 1.' },
      {
        input: 's = "pwwkew"',
        output: "3",
        explanation: 'The answer is "wke" — note it must be a substring, not a subsequence like "pwke".',
      },
    ],
    constraints: ["0 <= s.length <= 5 * 10^4", "s consists of English letters, digits, symbols and spaces."],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(s) {\n  \n}",
      python: "def solve(s):\n    pass\n",
    },
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
      "Given an integer array nums, return an array answer such that answer[i] is equal to the product of all the elements of nums except nums[i]. The product of any prefix or suffix of nums is guaranteed to fit in a 32-bit integer. You must write an algorithm that runs in O(n) time and without using the division operation.",
    examples: [
      { input: "nums = [1,2,3,4]", output: "[24,12,8,6]" },
      { input: "nums = [-1,1,0,-3,3]", output: "[0,0,9,0,0]" },
    ],
    constraints: [
      "2 <= nums.length <= 10^5",
      "-30 <= nums[i] <= 30",
      "The input is generated such that answer[i] fits in a 32-bit integer.",
      "Follow-up: solve it in O(1) extra space (the output array does not count).",
    ],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(nums) {\n  \n}",
      python: "def solve(nums):\n    pass\n",
    },
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
    examples: [
      {
        input: "height = [0,1,0,2,1,0,1,3,2,1,2,1]",
        output: "6",
        explanation: "The elevation map traps 6 units of rain water in the valleys between the bars.",
      },
      { input: "height = [4,2,0,3,2,5]", output: "9" },
    ],
    constraints: ["n == height.length", "0 <= n <= 2 * 10^4", "0 <= height[i] <= 10^5"],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(height) {\n  \n}",
      python: "def solve(height):\n    pass\n",
    },
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
      "Given two sorted arrays nums1 and nums2 of size m and n respectively, return the median of the two sorted arrays. The overall run time complexity should be O(log(m+n)).",
    examples: [
      {
        input: "nums1 = [1,3], nums2 = [2]",
        output: "2.0",
        explanation: "The merged array is [1,2,3] and its median is 2.",
      },
      {
        input: "nums1 = [1,2], nums2 = [3,4]",
        output: "2.5",
        explanation: "The merged array is [1,2,3,4] and its median is (2 + 3) / 2 = 2.5.",
      },
    ],
    constraints: [
      "nums1.length == m, nums2.length == n",
      "0 <= m <= 1000, 0 <= n <= 1000",
      "1 <= m + n <= 2000",
      "-10^6 <= nums1[i], nums2[i] <= 10^6",
    ],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(nums1, nums2) {\n  \n}",
      python: "def solve(nums1, nums2):\n    pass\n",
    },
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
      "Given a string s and a dictionary of strings wordDict, return true if s can be segmented into a space-separated sequence of one or more dictionary words. Note that the same word in the dictionary may be reused multiple times in the segmentation.",
    examples: [
      {
        input: 's = "leetcode", wordDict = ["leet","code"]',
        output: "true",
        explanation: '"leetcode" can be segmented as "leet code".',
      },
      {
        input: 's = "applepenapple", wordDict = ["apple","pen"]',
        output: "true",
        explanation: '"applepenapple" can be segmented as "apple pen apple" — dictionary words may be reused.',
      },
      { input: 's = "catsandog", wordDict = ["cats","dog","sand","and","cat"]', output: "false" },
    ],
    constraints: [
      "1 <= s.length <= 300",
      "1 <= wordDict.length <= 1000",
      "1 <= wordDict[i].length <= 20",
      "s and wordDict[i] consist of only lowercase English letters.",
      "All the strings of wordDict are unique.",
    ],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(s, wordDict) {\n  \n}",
      python: "def solve(s, wordDict):\n    pass\n",
    },
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
      "There are a total of numCourses courses you have to take, labeled from 0 to numCourses - 1. You are given an array prerequisites where prerequisites[i] = [a, b] indicates that you must take course b first if you want to take course a. Return true if you can finish all courses (i.e. the prerequisite graph has no cycle), otherwise return false.",
    examples: [
      {
        input: "numCourses = 2, prerequisites = [[1,0]]",
        output: "true",
        explanation: "To take course 1 you should have finished course 0 — possible.",
      },
      {
        input: "numCourses = 2, prerequisites = [[1,0],[0,1]]",
        output: "false",
        explanation: "Course 1 requires course 0, and course 0 requires course 1 — a cycle, so it is impossible.",
      },
    ],
    constraints: [
      "1 <= numCourses <= 2000",
      "0 <= prerequisites.length <= 5000",
      "prerequisites[i].length == 2",
      "0 <= a, b < numCourses",
      "All the pairs prerequisites[i] are unique.",
    ],
    functionName: "solve",
    starterCode: {
      javascript: "function solve(numCourses, prerequisites) {\n  \n}",
      python: "def solve(numCourses, prerequisites):\n    pass\n",
    },
    testCases: [
      { input: [2, [[1, 0]]], expected: true },
      { input: [2, [[1, 0], [0, 1]]], expected: false },
      { input: [4, [[1, 0], [2, 0], [3, 1], [3, 2]]], expected: true },
    ],
  },
];
