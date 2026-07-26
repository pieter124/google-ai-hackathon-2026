import { GEMINI_MODEL, CRITERIA_DEFINITIONS } from "../config.js";
import { mergeCriteriaLog } from "../utils/criteria.js";

// Same-origin proxy (server/server.js) that attaches auth and forwards to
// Google, so no API key lives in the browser.
const GEMINI_PROXY_ENDPOINT = "/api/gemini/generate";
const VALID_CRITERIA_IDS = CRITERIA_DEFINITIONS.map((c) => c.id).join(", ");

// The anchored rubric, rendered once from config so the live matrix, the
// checkpoints and the final report all score against identical wording.
// Anchors, not just labels, are what stop an LLM scorer drifting between
// turns — see RESEARCH.md.
const CRITERIA_SPEC = CRITERIA_DEFINITIONS.map(
  (c) => `- ${c.id} ("${c.label}"): ${c.definition} [1 = ${c.anchors[1]}; 3 = ${c.anchors[3]}; 5 = ${c.anchors[5]}]`
).join("\n");

// Shared by every scoring prompt (turn, checkpoint, scorecard) so the live
// matrix and the final report stay consistent in strictness.
const GRADING_RUBRIC = `Grade against a real top-tier hiring bar, strictly, using these anchored dimensions:
${CRITERIA_SPEC}
- 1 = well below bar, 2 = below bar, 3 = meets the bar with reservations, 4 = clearly strong, 5 = exceptional and rare — most sessions should never see a 5.
- Actively penalize: missing or hand-wavy complexity discussion, unhandled edge cases, rambling or unclear communication, needing proactive nudges, and code that doesn't pass the tests.
- Communication is a CAP, not an additive: if the interviewer struggled to follow the candidate, no other dimension may exceed the communication score by more than 1. A strong coder nobody can follow is a real-world reject.
- Never inflate a score to be kind; when torn between two scores, give the lower one.`;

// Per-turn interviewer behavior, adapted from the conversation-dynamics and
// intelligent-tutoring literature (talk ratio, wait-time, the assistance
// dilemma, and the hint ladder — citations in RESEARCH.md). Kept separate
// from the persona text so every character obeys the same pedagogy while
// still sounding like themselves.
const INTERVIEWER_BEHAVIOR = `Interviewer behavior (research-backed): let the candidate do roughly 60% of the
talking and drive the session; be quietest while they are actively coding, and
don't rush to fill a short silence — think-time is productive. When they are
stuck, climb a hint ladder ONE rung at a time — (0) reflective prompt ("talk me
through what you have"), (1) point at where to look, (2) name the technique,
(3) the concrete next step — and NEVER volunteer the near-answer bottom-out
hint unless time is nearly up.`;

// What each phase of the session means for the interviewer, so a turn fired
// during "read the problem" doesn't behave like one fired mid-implementation.
const PHASE_GUIDANCE = {
  reading:
    "PHASE: the candidate is inside their 3-minute reading window. Answer clarifying questions about the problem, but do NOT discuss solutions, approaches, or hints yet.",
  approach:
    "PHASE: the candidate should be explaining their intended approach out loud, before writing code. Probe the plan — complexity, edge cases, why this over the alternative — rather than the code.",
  implementing:
    "PHASE: the candidate is implementing. Stay mostly quiet, react to what they write and run, and intervene only per your hint posture.",
};

const LANGUAGE_LABELS = { javascript: "JavaScript", python: "Python" };

// Renders the problem the way the candidate sees it, so every prompt reasons
// from the same statement.
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

// Carries the HTTP status so callers can tell a 400 (e.g. an unsupported audio
// format) from a timeout — that's what drives the audio→STT fallback.
export class GeminiHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

// fetch() has no built-in timeout; without one a stalled request leaves the
// "Thinking..." spinner stuck forever.
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

// We ask for JSON, but the model occasionally wraps it in markdown fences —
// strip those before parsing.
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

// Agent 1 and Agent 2 each rate the candidate's CURRENT trajectory from -1
// (moving away from a correct solution) to +1 (closing in). The series of
// these is what the scorecard's path chart draws, so a missing or garbage
// value has to degrade to "treading water" rather than break the chart.
function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

// Keep only known criterion ids with a valid 1-5 score, so a hallucinated id
// or malformed score can't corrupt the log.
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

// The interviewer, per turn. Drives voice turns, Run Code reactions, and the
// watchdog's proactive nudges — all funnel through here with a one-line
// `latestEvent`, which keeps persona and criteria consistent across triggers.
// Voice turns attach the raw recording for native audio understanding; if
// Gemini 400s on the format, the caller falls back to STT and retries with text.
export async function callGeminiInterviewTurn({
  currentProblem,
  personaDescription,
  hintPosture,
  phase,
  language,
  code,
  lastTestResults,
  transcript,
  criteriaLog,
  latestEvent,
  audio, // optional { base64, mimeType }
}) {
  const prompt = `You are acting as a coding interviewer with this persona: ${personaDescription}
Hint posture: ${
    hintPosture === "generous"
      ? "offer escalating hints readily — vague first, more concrete only if they stay stuck"
      : "give hints sparingly; expect the candidate to drive, and only nudge once they have clearly tried"
  }.
${PHASE_GUIDANCE[phase] || PHASE_GUIDANCE.implementing}
Problem:
${describeProblem(currentProblem)}

The candidate is coding in ${LANGUAGE_LABELS[language] || "JavaScript"}.
Candidate's current code:
${code}

Most recent test results (if any): ${JSON.stringify(lastTestResults)}
Criteria tracked so far this session (score 1-5, higher is better; ids missing here haven't been scored yet): ${JSON.stringify(mergeCriteriaLog(criteriaLog))}
Full transcript so far: ${JSON.stringify(transcript)}
Latest event: ${latestEvent}${audio ? "\nThe candidate's raw spoken audio for this turn is attached as well — factor in tone, hesitation, and fluency, not just the words." : ""}

Respond as the interviewer would in exactly ONE turn. Your reply is spoken
aloud by a text-to-speech voice, so write it the way a real person talks in
conversation, not the way anyone writes: contractions, natural spoken rhythm,
and — where it fits the persona — brief verbal reactions ("Hmm.", "Okay.",
"Right...") and thinking pauses marked with ellipses. Usually one to three
short sentences; never markdown, bullet points, code blocks, emoji, or stage
directions. Use ONLY plain speakable words: no brackets, parentheses,
backticks, quotes around identifiers, or code syntax of any kind — say code
aloud the way an engineer would in conversation ("nums of i", "i plus one",
"big O of n squared"). If the candidate
just ran code, react to the actual pass/fail results and their code, don't ask
about something already visible. If they explained their approach, follow up
on anything vague or ask about complexity/edge cases. If this is a proactive
nudge (the candidate seems stuck), offer a small escalating hint in character
without giving away the full solution — start vague, only get more concrete
if they were already stuck last time too. Stay in character for the persona
given.

${INTERVIEWER_BEHAVIOR}

After forming your response, rate the candidate's CURRENT trajectory in
"progress", from -1 (moving away from a correct or optimal solution) through 0
(treading water) to +1 (closing in on it). Then update whichever of these
criteria you now have real signal for (valid ids: ${VALID_CRITERIA_IDS}) —
it's fine to leave others out if this turn didn't touch them.
${GRADING_RUBRIC}${audio ? '\nAlso transcribe the candidate\'s spoken words from the attached audio, verbatim, into "candidateTranscript".' : ""}

Return ONLY valid JSON in this exact shape, no other text:
{ "response": "..."${audio ? ', "candidateTranscript": "..."' : ""}, "progress": 0.0, "criteriaUpdate": { "<criterionId>": { "score": 1-5, "note": "..." } } }`;

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
    progress: clampProgress(parsed.progress),
    criteriaUpdate: sanitizeCriteriaUpdate(parsed.criteriaUpdate),
    candidateTranscript: typeof parsed.candidateTranscript === "string" ? parsed.candidateTranscript.trim() : "",
  };
}

// The aggregator. Runs on a timer and reviews the whole window since the last
// checkpoint, so slow drift and long idle stretches still get logged.
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
all, or drift that only shows up across several exchanges. Rate progress
DURING THIS WINDOW in "progress", from -1 (backwards, idle, or stuck) to +1
(clear forward progress). Update whichever of these criteria you have real
signal for (valid ids: ${VALID_CRITERIA_IDS}).
${GRADING_RUBRIC}

Return ONLY valid JSON in this exact shape, no other text:
{ "progress": 0.0, "criteriaUpdate": { "<criterionId>": { "score": 1-5, "note": "..." } } }`;

  const data = await postGenerateContent(GEMINI_MODEL, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
  });

  const parsed = parseJsonResponse(extractText(data));
  return { progress: clampProgress(parsed.progress), criteriaUpdate: sanitizeCriteriaUpdate(parsed.criteriaUpdate) };
}

// End-of-session report. Merges the criteriaLog, local filler stats, and the
// sandboxed test results into the final scorecard.
export async function callGeminiScorecard({
  currentProblem,
  language,
  code,
  lastTestResults,
  transcript,
  criteriaLog,
  fillerStats,
  watchdogNudgeCount,
  progressSeries = [],
}) {
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
Trajectory over time — each point is (t in ms since the session started, progress from -1 to +1): ${JSON.stringify(progressSeries)}

Produce a coaching scorecard. For each criterion, give a final score out of 5
and a short note that cites a concrete moment (a transcript quote, a code
choice, a test result) and reflects how the criterion evolved across the whole
session, not just the last update.
${GRADING_RUBRIC}

Also produce a path narrative: a short account of which states the candidate
moved through (understanding the problem, attempting an approach, getting
stuck, receiving hints, adjusting or staying stuck, reaching a clean solution
or running out of time) and where the friction was. Read the shape of the
trajectory array above — did they climb steadily, thrash, or drift the wrong
way? Treat the filler rate as a soft coaching signal, never a penalty: it
partly reflects nerves and speaking style, not competence.

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
