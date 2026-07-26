import { getApiKey, GEMINI_MODEL, RUBRIC } from "../config.js";

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const VALID_CRITERIA_IDS = RUBRIC.map((c) => c.id).join(", ");

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

// Keeps only recognized rubric ids with a valid 1-5 score, so a model
// hallucinating an unknown id or a malformed score can't corrupt the live
// criteria matrix. (Pattern adopted from the team's `main` branch.)
function sanitizeCriteriaUpdate(raw) {
  const validIds = new Set(RUBRIC.map((c) => c.id));
  const clean = {};
  for (const [id, value] of Object.entries(raw || {})) {
    const score = Math.round(Number(value?.score));
    if (validIds.has(id) && Number.isFinite(score) && score >= 1 && score <= 5) {
      clean[id] = { score, note: typeof value?.note === "string" ? value.note : "" };
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// AGENT 1 — Interviewer (per turn). Drives the in-character interviewer for
// all triggers (voice turn, run-code, watchdog nudge). Returns the reply plus
// two live signals:
//   • progress: -1..+1 trajectory (feeds the path chart);
//   • criteriaUpdate: partial 1-5 scores for whichever rubric dimensions this
//     turn gave real signal on (feeds the live Criteria Matrix).
// The running merged criteria are passed back in as context so scores evolve
// coherently instead of resetting each turn — this replaces the old hidden
// "impressions" blob with something the candidate can actually see.
// ---------------------------------------------------------------------------
export async function callGeminiInterviewTurn({
  currentProblem,
  personaDescription,
  hintPosture,
  language,
  code,
  lastTestResults,
  transcript,
  liveCriteria,
  latestEvent,
}) {
  const prompt = `You are acting as a coding interviewer with this persona: ${personaDescription}
Hint posture: ${hintPosture === "generous" ? "offer escalating hints readily — vague first, more concrete only if they stay stuck" : "give hints sparingly; expect the candidate to drive and only nudge after they've clearly tried"}.
The candidate is coding in ${language || "javascript"} (the solve function).
Problem: ${currentProblem.title} — ${currentProblem.description}

Candidate's current code:
${code}

Most recent test results (if any): ${JSON.stringify(lastTestResults)}
Criteria scored so far this session (1-5, higher is better; ids missing haven't been scored yet): ${JSON.stringify(liveCriteria || {})}
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

Then rate the candidate's CURRENT trajectory from -1 (moving away from a
correct/optimal solution) through 0 (treading water) to +1 (closing in), and
update whichever of these criteria you now have real signal for (valid ids:
${VALID_CRITERIA_IDS}) — leave others out if this turn didn't touch them.

Return ONLY valid JSON in this exact shape, no other text:
{ "response": "...", "progress": 0.0, "criteriaUpdate": { "<criterionId>": { "score": 1-5, "note": "..." } } }`;

  const parsed = await generateJson(prompt, { temperature: 0.8 });
  if (typeof parsed.response !== "string") {
    throw new Error("Gemini returned an unexpected shape for the interview turn.");
  }
  return {
    response: parsed.response,
    progress: clampProgress(parsed.progress),
    criteriaUpdate: sanitizeCriteriaUpdate(parsed.criteriaUpdate),
  };
}

// ---------------------------------------------------------------------------
// AGENT 2 — Aggregator (periodic checkpoint). Fires on a timer, independent of
// turns. Analyzes the window since the last checkpoint — including idle
// stretches no turn covered — and returns a windowed progress read + note (for
// the path chart) plus criteria updates (for the live matrix). Cheap, low
// temperature, short timeout: it must never block the live loop.
// ---------------------------------------------------------------------------
export async function callGeminiCheckpoint({ currentProblem, code, windowTranscript, keystrokeSummary, liveCriteria }) {
  const prompt = `You are silently monitoring a live coding interview (the candidate cannot see this note, but they can see the criteria scores).
Problem: ${currentProblem.title} — ${currentProblem.description}
Candidate's current code:
${code}
What they said in the last few minutes: ${windowTranscript || "(nothing said this window)"}
Typing activity this window: ${keystrokeSummary}
Criteria scored so far this session: ${JSON.stringify(liveCriteria || {})}

Analyze this whole window rather than one exchange (catch drift or a long idle
stretch a single turn would miss). In one sentence, note how it went. Rate
progress DURING THIS WINDOW from -1 (backwards/idle/stuck) to +1 (clear
progress). Update whichever criteria you have real signal for (valid ids:
${VALID_CRITERIA_IDS}).

Return ONLY valid JSON: { "note": "...", "progress": 0.0, "criteriaUpdate": { "<criterionId>": { "score": 1-5, "note": "..." } } }`;

  const parsed = await generateJson(prompt, { temperature: 0.3, timeoutMs: 15000 });
  return {
    note: typeof parsed.note === "string" ? parsed.note : "",
    progress: clampProgress(parsed.progress),
    criteriaUpdate: sanitizeCriteriaUpdate(parsed.criteriaUpdate),
  };
}

// ---------------------------------------------------------------------------
// END-OF-SESSION REPORT. Reads the merged signals (the whole criteria log +
// filler stats + path series), NOT raw audio, and produces the authoritative
// coaching report: a 1-5 score per rubric dimension, a path narrative, and a
// verdict. The rubric is injected from config so scoring criteria live in one
// place.
// ---------------------------------------------------------------------------
const RUBRIC_SPEC = RUBRIC.map(
  (d) => `- ${d.id} ("${d.label}"): ${d.definition} [1 = ${d.anchors[1]}; 3 = ${d.anchors[3]}; 5 = ${d.anchors[5]}]`
).join("\n");

export async function callGeminiReport({
  currentProblem,
  code,
  lastTestResults,
  transcript,
  criteriaLog,
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
Criteria history across the whole session (chronological per-turn and per-checkpoint updates): ${JSON.stringify(criteriaLog)}
Windowed checkpoint notes: ${JSON.stringify(checkpointNotes)}
Hints/nudges used: ${hintsUsed}
Measured speech fillers (local count, not your estimate): ${fillerStats.fillers} filler words of ${fillerStats.total} spoken (${(fillerStats.ratio * 100).toFixed(0)}%)
Progress trajectory over time (t in ms, -1..1): ${JSON.stringify(progressSeries)}

Rubric — score EACH dimension 1-5 using these anchors and how it evolved across
the whole session (not just the last update):
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
