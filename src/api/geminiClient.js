import { GEMINI_MODEL, CRITERIA_DEFINITIONS } from "../config.js";
import { mergeCriteriaLog } from "../utils/criteria.js";

// Same-origin proxy served by server/server.js — it attaches either a plain
// Gemini API key or an Application Default Credentials token and forwards to
// Google, so no API key travels through (or lives in) the browser. Voice
// output goes through Google Cloud Text-to-Speech instead (see
// api/speechClient.js), not through this endpoint.
const GEMINI_PROXY_ENDPOINT = "/api/gemini/generate";
const VALID_CRITERIA_IDS = CRITERIA_DEFINITIONS.map((c) => c.id).join(", ");

// Deliberately harsh calibration, shared by every prompt that scores the
// candidate (per-turn, checkpoint, scorecard) so the live matrix and the
// final report can't drift apart in strictness.
const GRADING_RUBRIC = `Grade against a real top-tier hiring bar, strictly:
- 1 = well below bar, 2 = below bar, 3 = meets the bar with reservations, 4 = clearly strong, 5 = exceptional and rare — most sessions should never see a 5.
- Actively penalize: missing or hand-wavy complexity discussion, unhandled edge cases, rambling or unclear communication, needing proactive nudges, and code that doesn't pass the tests.
- Never inflate a score to be kind; when torn between two scores, give the lower one.`;

const LANGUAGE_LABELS = { javascript: "JavaScript", python: "Python" };

// One shared textual rendering of the problem (description + LeetCode-style
// examples and constraints) so every agent reasons from the same statement
// the candidate sees on screen.
function describeProblem(problem) {
  const examples = (problem.examples || [])
    .map(
      (ex, i) =>
        `Example ${i + 1}: Input: ${ex.input} -> Output: ${ex.output}${ex.explanation ? ` (${ex.explanation})` : ""}`
    )
    .join("\n");
  const constraints = (problem.constraints || []).map((c) => `- ${c}`).join("\n");
  return `${problem.title} [${problem.difficulty}]
${problem.description}
${examples}
Constraints:
${constraints}`;
}

// Thrown on any non-2xx Gemini response, carrying the HTTP status so callers
// can tell "bad request" (e.g. an audio MIME type Gemini won't accept) apart
// from a timeout or outage — that distinction is what drives the
// native-audio-in → Speech-to-Text fallback in InterviewScreen.
export class GeminiHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

// fetch() has no built-in timeout; without one, a stalled request would leave
// the "processing"/"Thinking..." spinner stuck forever, violating the "never
// leave the UI silently stuck" requirement.
async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out — the interviewer didn't respond in time.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function postGenerateContent(model, body, timeoutMs) {
  const res = await fetchWithTimeout(
    GEMINI_PROXY_ENDPOINT,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, ...body }) },
    timeoutMs
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new GeminiHttpError(`Gemini API error ${res.status}: ${errBody || res.statusText}`, res.status);
  }
  return res.json();
}

// Gemini is asked for responseMimeType "application/json" so this should
// already be clean JSON, but models occasionally wrap output in markdown
// code fences anyway — strip those defensively before parsing.
function parseJsonResponse(rawText) {
  let text = (rawText || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error("Could not parse the interviewer's response as JSON.");
  }
}

function extractText(geminiData) {
  const parts = geminiData?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

// Keeps only recognized criterion ids with a valid 1-5 score, so a model
// hallucinating an unknown id or a malformed score can't corrupt the log.
function sanitizeCriteriaUpdate(raw) {
  const validIds = new Set(CRITERIA_DEFINITIONS.map((c) => c.id));
  const clean = {};
  for (const [id, value] of Object.entries(raw || {})) {
    const score = Number(value?.score);
    if (validIds.has(id) && Number.isFinite(score) && score >= 1 && score <= 5) {
      clean[id] = { score, note: typeof value.note === "string" ? value.note : "" };
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE — Gemini (generativelanguage.googleapis.com)
//
// AGENT 1 (Interviewer, per turn). Drives the in-character interviewer for
// voice turns, Run Code reactions, AND Agent 3's (Watchdog) proactive
// nudges — all three funnel through this one function with a one-line
// `latestEvent` description of what just happened, which is what keeps
// persona and the running criteria consistent no matter which trigger fired.
//
// Voice turns prefer sending the candidate's raw recorded audio directly as
// an inline_data part (native audio understanding — richer than transcribed
// text alone, since Gemini can factor in tone/hesitation/fluency). Chrome's
// MediaRecorder only produces audio/webm, which is NOT in Gemini's
// documented supported input list (wav/mp3/aiff/aac/ogg/flac) — so this may
// or may not be accepted. If Gemini 400s on it, the caller (InterviewScreen)
// catches the GeminiHttpError, falls back to the Cloud Speech-to-Text call,
// and retries this same function with `candidateText` instead of `audio`.
// ---------------------------------------------------------------------------
export async function callGeminiInterviewTurn({
  currentProblem,
  personaDescription,
  language,
  code,
  lastTestResults,
  transcript,
  criteriaLog,
  latestEvent,
  audio, // optional { base64, mimeType }
}) {
  const prompt = `You are acting as a coding interviewer with this persona: ${personaDescription}
Problem:
${describeProblem(currentProblem)}

The candidate is coding in ${LANGUAGE_LABELS[language] || "JavaScript"}.
Candidate's current code:
${code}

Most recent test results (if any): ${JSON.stringify(lastTestResults)}
Criteria tracked so far this session (score 1-5, higher is better; ids missing here haven't been scored yet): ${JSON.stringify(mergeCriteriaLog(criteriaLog))}
Full transcript so far: ${JSON.stringify(transcript)}
Latest event: ${latestEvent}${audio ? "\nThe candidate's raw spoken audio for this turn is attached as well — factor in tone, hesitation, and fluency, not just the words." : ""}

Respond as the interviewer would in exactly ONE turn, and keep it SPOKEN-length
— a few sentences at most, since your reply is read aloud. If the candidate
just ran code, react to the actual pass/fail results and their code, don't ask
about something already visible. If they explained their approach, follow up
on anything vague or ask about complexity/edge cases. If this is a proactive
nudge (the candidate seems stuck), offer a small escalating hint in character
without giving away the full solution — start vague, only get more concrete
if they were already stuck last time too. Stay in character for the persona
given. After forming your response, update whichever of these criteria you
now have real signal for (valid ids: ${VALID_CRITERIA_IDS}) — it's fine to
leave others out if this turn didn't touch them.
${GRADING_RUBRIC}${audio ? '\nAlso transcribe the candidate\'s spoken words from the attached audio, verbatim, into "candidateTranscript".' : ""}

Return ONLY valid JSON in this exact shape, no other text:
{ "response": "..."${audio ? ', "candidateTranscript": "..."' : ""}, "criteriaUpdate": { "<criterionId>": { "score": 1-5, "note": "..." } } }`;

  const parts = [{ text: prompt }];
  if (audio) parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.base64 } });

  const data = await postGenerateContent(GEMINI_MODEL, {
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
  });

  const parsed = parseJsonResponse(extractText(data));
  if (typeof parsed.response !== "string") {
    throw new Error("Gemini returned an unexpected shape for the interview turn.");
  }
  return {
    response: parsed.response,
    criteriaUpdate: sanitizeCriteriaUpdate(parsed.criteriaUpdate),
    candidateTranscript: typeof parsed.candidateTranscript === "string" ? parsed.candidateTranscript.trim() : "",
  };
}

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE — Gemini, AGENT 2 (Aggregator).
//
// Fires on a timer independent of turns (see InterviewScreen's checkpoint
// interval), not on a click. Looks at the whole window since the last
// checkpoint — including stretches where no turn was sent at all — so slow
// drift and long idle windows still get analyzed and logged, not silently
// skipped.
// ---------------------------------------------------------------------------
export async function callGeminiCheckpoint({ currentProblem, language, code, transcriptSlice, codeChangeSummary, criteriaLog }) {
  const prompt = `You are the Aggregator for a live coding interview — an independent, periodic checkpoint, not a reply to any one turn.
Problem:
${describeProblem(currentProblem)}
The candidate is coding in ${LANGUAGE_LABELS[language] || "JavaScript"}.
Candidate's current code:
${code}
Code activity in this window: ${codeChangeSummary}
Transcript since the last checkpoint (may be empty — that itself is a signal): ${JSON.stringify(transcriptSlice)}
Criteria tracked so far this session: ${JSON.stringify(mergeCriteriaLog(criteriaLog))}

Analyze this whole window rather than one exchange — catch things a single
turn's reasoning would miss, such as a long idle stretch with no turn sent at
all, or drift that only shows up across several exchanges. Update whichever
of these criteria you have real signal for (valid ids: ${VALID_CRITERIA_IDS}).
${GRADING_RUBRIC}

Return ONLY valid JSON in this exact shape, no other text:
{ "criteriaUpdate": { "<criterionId>": { "score": 1-5, "note": "..." } } }`;

  const data = await postGenerateContent(GEMINI_MODEL, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const parsed = parseJsonResponse(extractText(data));
  return { criteriaUpdate: sanitizeCriteriaUpdate(parsed.criteriaUpdate) };
}

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE — Gemini, end-of-session report.
//
// Merges the Interviewer's per-turn criteria updates and the Aggregator's
// windowed checkpoints (the shared criteriaLog) — not raw audio/transcript —
// into the final scorecard, alongside locally-computed filler stats and the
// sandboxed test results.
// ---------------------------------------------------------------------------
export async function callGeminiScorecard({
  currentProblem,
  language,
  code,
  lastTestResults,
  transcript,
  criteriaLog,
  fillerStats,
  watchdogNudgeCount,
}) {
  const criteriaList = CRITERIA_DEFINITIONS.map((c) => `- ${c.id}: ${c.label}`).join("\n");

  const prompt = `Given this full interview session:
Problem:
${describeProblem(currentProblem)}
The candidate coded in ${LANGUAGE_LABELS[language] || "JavaScript"}.
Final code: ${code}
Final test results: ${JSON.stringify(lastTestResults)}
Full transcript: ${JSON.stringify(transcript)}
Criteria history across the whole session, per-turn and per-checkpoint, chronological: ${JSON.stringify(criteriaLog)}
Locally-measured filler-word stats (already computed, not yours to recompute): ${JSON.stringify(fillerStats)}
Number of times the interviewer had to proactively step in because the candidate seemed stuck: ${watchdogNudgeCount}

Produce a coaching scorecard. For each criterion below, give a final score out
of 5 and a short note informed by how it evolved across the whole session
(not just the last update):
${criteriaList}
${GRADING_RUBRIC}

Also produce a path narrative: a short account of which states the candidate
moved through (understanding the problem, attempting an approach, getting
stuck, receiving hints, adjusting or staying stuck, reaching a clean solution
or running out of time) and where the friction was.

Assess correctness from the final test results, estimate the time and space
complexity of the final code, and give a realistic hire/no-hire verdict with
brief reasoning. Default to "no-hire" unless the evidence is affirmatively
strong: an unsolved problem, failed tests, or repeated proactive nudges should
normally rule out "hire". "verdictDecision" must be exactly one of:
"hire", "lean-hire", "lean-no-hire", "no-hire".

Return ONLY valid JSON in this exact shape, no other text:
{
  "criteriaScores": [{ "id": "...", "score": 1-5, "note": "..." }],
  "pathNarrative": "...",
  "correctness": "...",
  "complexity": "...",
  "verdictDecision": "hire" | "lean-hire" | "lean-no-hire" | "no-hire",
  "verdict": "..."
}`;

  const data = await postGenerateContent(
    GEMINI_MODEL,
    {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
    },
    30000
  );

  const parsed = parseJsonResponse(extractText(data));
  const validDecisions = ["hire", "lean-hire", "lean-no-hire", "no-hire"];
  return {
    criteriaScores: Array.isArray(parsed.criteriaScores) ? parsed.criteriaScores : [],
    pathNarrative: parsed.pathNarrative || "",
    correctness: parsed.correctness || "Unknown",
    complexity: parsed.complexity || "Unknown",
    verdictDecision: validDecisions.includes(parsed.verdictDecision) ? parsed.verdictDecision : null,
    verdict: parsed.verdict || "",
  };
}
