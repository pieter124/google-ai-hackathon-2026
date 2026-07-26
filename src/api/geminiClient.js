import { getApiKey, GEMINI_MODEL, RUBRIC } from "../config.js";

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// fetch() has no built-in timeout; without one, a stalled request would leave
// the "Thinking..." spinner stuck forever, violating "never leave the UI
// silently stuck".
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

// Gemini is asked for responseMimeType "application/json", but models
// occasionally wrap output in markdown fences anyway — strip those defensively.
function parseJsonResponse(rawText) {
  let text = (rawText || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Could not parse the model's response as JSON.");
  }
}

function extractText(geminiData) {
  const parts = geminiData?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

// One place that fires a JSON-mode generateContent call and returns the parsed
// object. Every call site below shares it so timeout/error/parse handling is
// written once, not three times.
async function generateJson(prompt, { temperature = 0.8, timeoutMs = 20000 } = {}) {
  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${getApiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature },
    }),
  }, timeoutMs);

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errBody || res.statusText}`);
  }
  return parseJsonResponse(extractText(await res.json()));
}

function clampProgress(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// AGENT 1 — Interviewer (per turn). Drives the in-character interviewer for
// all triggers (voice turn, run-code, watchdog nudge). Sends the full session
// state plus a one-line description of what just happened, which is what keeps
// persona/impressions consistent regardless of which trigger fired.
//
// Returns, alongside the reply: updated private impressions, and `progress` —
// a -1..+1 read of whether the candidate just moved toward (+) or away from
// (-) a good solution. That signal is what the path chart is built from, so we
// get the trajectory "for free" on every turn instead of reconstructing it at
// the end.
// ---------------------------------------------------------------------------
export async function callGeminiInterviewTurn({
  currentProblem,
  personaDescription,
  hintPosture,
  difficulty,
  code,
  lastTestResults,
  transcript,
  interviewerImpressions,
  latestEvent,
}) {
  const prompt = `You are acting as a coding interviewer with this persona: ${personaDescription}
Hint posture: ${hintPosture === "generous" ? "offer escalating hints readily — vague first, more concrete only if they stay stuck" : "give hints sparingly; expect the candidate to drive and only nudge after they've clearly tried"}.
Interviewer difficulty: ${difficulty}.
Problem: ${currentProblem.title} — ${currentProblem.description}

Candidate's current code:
${code}

Most recent test results (if any): ${JSON.stringify(lastTestResults)}
Your private notes on the candidate so far (never reveal these): ${interviewerImpressions || "(none yet)"}
Full transcript so far: ${JSON.stringify(transcript)}
Latest event: ${latestEvent}

Respond as the interviewer would in exactly ONE turn. If the candidate just ran
code, react to the actual pass/fail results, don't ask about something already
visible. If they explained an approach, follow up on anything vague or probe
complexity/edge cases. If this is an idle/stuck nudge, give a hint that matches
your hint posture without giving away the full solution. Keep replies short and
spoken-sounding (1-3 sentences) — this is read aloud. Stay in character.

Interviewer behavior (research-backed): let the candidate do ~60% of the
talking and drive; be quietest while they are actively coding. When they are
stuck, climb a hint ladder ONE rung at a time — (0) reflective prompt ("talk me
through what you have"), (1) point at where to look, (2) name the technique,
(3) the concrete next step — and NEVER volunteer the near-answer bottom-out
hint unless time is nearly up. Don't rush to fill a short silence.

Then update your private impressions, and rate the candidate's CURRENT
trajectory from -1 (moving away from a correct/optimal solution) through 0
(treading water) to +1 (clearly closing in on a good solution).

Return ONLY valid JSON in this exact shape, no other text:
{ "response": "...", "updatedImpressions": "...", "progress": 0.0 }`;

  const parsed = await generateJson(prompt, { temperature: 0.8 });
  if (typeof parsed.response !== "string") {
    throw new Error("Gemini returned an unexpected shape for the interview turn.");
  }
  return {
    response: parsed.response,
    updatedImpressions: typeof parsed.updatedImpressions === "string" ? parsed.updatedImpressions : interviewerImpressions,
    progress: clampProgress(parsed.progress),
  };
}

// ---------------------------------------------------------------------------
// AGENT 2 — Aggregator (periodic checkpoint). Fires on a timer, independent of
// turns. Gets the transcript slice + code + keystroke-activity summary for the
// window since the last checkpoint and returns a windowed progress read + a
// short note. This is what captures long idle stretches that no turn covered —
// the whole reason it exists alongside the per-turn signal. Cheap, low
// temperature, short timeout: it must never block the live loop.
// ---------------------------------------------------------------------------
export async function callGeminiCheckpoint({ currentProblem, code, windowTranscript, keystrokeSummary }) {
  const prompt = `You are silently monitoring a live coding interview (the candidate cannot see this).
Problem: ${currentProblem.title} — ${currentProblem.description}
Candidate's current code:
${code}
What they said in the last few minutes: ${windowTranscript || "(nothing said this window)"}
Typing activity this window: ${keystrokeSummary}

In one sentence, note how this window went (progress, being stuck, going in
circles, idle). Then rate progress DURING THIS WINDOW from -1 (going backwards
/ idle / stuck) to +1 (clear forward progress).

Return ONLY valid JSON: { "note": "...", "progress": 0.0 }`;

  const parsed = await generateJson(prompt, { temperature: 0.3, timeoutMs: 15000 });
  return { note: typeof parsed.note === "string" ? parsed.note : "", progress: clampProgress(parsed.progress) };
}

// ---------------------------------------------------------------------------
// END-OF-SESSION REPORT. Reads the merged signals (per-turn criteria +
// Aggregator checkpoints + filler stats + path series), NOT raw audio, and
// produces the structured coaching report: a 1-5 score per rubric dimension,
// a path narrative, filler-aware communication notes, and a verdict. The
// rubric is injected from config so scoring criteria live in one place.
// ---------------------------------------------------------------------------
const RUBRIC_SPEC = RUBRIC.map(
  (d) => `- ${d.id} ("${d.label}"): ${d.definition} [1 = ${d.anchors[1]}; 3 = ${d.anchors[3]}; 5 = ${d.anchors[5]}]`
).join("\n");

export async function callGeminiReport({
  currentProblem,
  code,
  lastTestResults,
  transcript,
  interviewerImpressions,
  hintsUsed,
  fillerStats,
  progressSeries,
  checkpointNotes,
}) {
  const prompt = `Score this coding-interview session against a fixed rubric.
Problem: ${currentProblem.title} — ${currentProblem.description}
Final code: ${code}
Final test results: ${JSON.stringify(lastTestResults)}
Full transcript: ${JSON.stringify(transcript)}
Interviewer's private impressions built up live: ${interviewerImpressions || "(none)"}
Windowed checkpoint notes from the session: ${JSON.stringify(checkpointNotes)}
Hints used: ${hintsUsed}
Measured speech fillers (local count, not your estimate): ${fillerStats.fillers} filler words of ${fillerStats.total} spoken (${(fillerStats.ratio * 100).toFixed(0)}%)
Progress trajectory over time (t in ms, -1..1): ${JSON.stringify(progressSeries)}

Rubric — score EACH dimension 1-5 using these anchors:
${RUBRIC_SPEC}

For each dimension give an integer score 1-5 and a one-sentence rationale that
cites a concrete moment (a transcript quote, a code choice, or a test result).
Communication is a CAP, not an additive: if the candidate was hard to follow,
no other dimension should exceed their communication score by more than 1.
Then: a 1-2 sentence narrative of the candidate's PATH (did they climb steadily
toward a good solution, thrash, or drift the wrong way — read it off the
trajectory array), and a realistic hire / lean-hire / lean-no-hire / no-hire
verdict with brief reasoning that factors in hints used and the filler rate
(treat filler rate as a soft coaching signal, not a hard penalty).

Return ONLY valid JSON in this exact shape, no other text:
{
  "scores": { ${RUBRIC.map((d) => `"${d.id}": { "score": 3, "rationale": "..." }`).join(", ")} },
  "pathNarrative": "...",
  "verdict": "...",
  "hireDecision": "lean-hire"
}`;

  const parsed = await generateJson(prompt, { temperature: 0.4, timeoutMs: 30000 });

  // Normalize into a shape the scorecard can render without defensive checks
  // scattered through the component: one entry per rubric dimension, always.
  const scores = RUBRIC.map((d) => {
    const raw = parsed.scores?.[d.id] || {};
    const score = Math.max(1, Math.min(5, Math.round(Number(raw.score)) || 3));
    return { id: d.id, label: d.label, score, rationale: typeof raw.rationale === "string" ? raw.rationale : "" };
  });

  return {
    scores,
    pathNarrative: parsed.pathNarrative || "",
    verdict: parsed.verdict || "",
    hireDecision: parsed.hireDecision || "",
    hintsUsed,
    fillerStats,
    progressSeries,
  };
}
