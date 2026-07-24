import { GOOGLE_API_KEY, GEMINI_MODEL } from "../config.js";

const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE 1 of 3 — Gemini (generativelanguage.googleapis.com)
//
// This single function drives the in-character interviewer for ALL THREE
// triggers (voice turn, code run, idle nudge). Every trigger sends the same
// full session state (problem, settings, code, test results, transcript,
// private impressions) plus a one-line description of what just happened —
// that's what keeps the persona and impressions consistent regardless of
// which trigger fired.
// ---------------------------------------------------------------------------
export async function callGeminiInterviewTurn({
  currentProblem,
  personaDescription,
  settings,
  code,
  lastTestResults,
  transcript,
  interviewerImpressions,
  latestEvent,
}) {
  const prompt = `You are acting as a coding interviewer with this persona: ${personaDescription}
Difficulty level: ${settings.difficulty}.
Problem: ${currentProblem.title} — ${currentProblem.description}

Candidate's current code:
${code}

Most recent test results (if any): ${JSON.stringify(lastTestResults)}
Your private notes on the candidate so far (never reveal these): ${interviewerImpressions || "(none yet)"}
Full transcript so far: ${JSON.stringify(transcript)}
Latest event: ${latestEvent}

Respond as the interviewer would in exactly ONE turn. If the candidate just ran
code, react to the actual pass/fail results and their code, don't ask about
something already visible. If they explained their approach, follow up on
anything vague or ask about complexity/edge cases. If this is an idle nudge,
offer a small hint in character without giving away the full solution. Stay in
character for the persona and difficulty level given. After forming your
response, update your private impressions of the candidate.

Return ONLY valid JSON in this exact shape, no other text:
{ "response": "...", "updatedImpressions": "..." }`;

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = await res.json();
  const parsed = parseJsonResponse(extractText(data));
  if (typeof parsed.response !== "string") {
    throw new Error("Gemini returned an unexpected shape for the interview turn.");
  }
  return {
    response: parsed.response,
    updatedImpressions: typeof parsed.updatedImpressions === "string" ? parsed.updatedImpressions : interviewerImpressions,
  };
}

// Same Gemini endpoint, used once at the end of the session to produce the
// coaching scorecard (still GOOGLE API CALL SITE 1 — same function family,
// just a different one-shot prompt instead of a per-turn one).
export async function callGeminiScorecard({ currentProblem, code, lastTestResults, transcript, interviewerImpressions, hintsUsed }) {
  const prompt = `Given this full interview session:
Problem: ${currentProblem.title} — ${currentProblem.description}
Final code: ${code}
Final test results: ${JSON.stringify(lastTestResults)}
Full transcript: ${JSON.stringify(transcript)}
Your private impressions built up during the interview: ${interviewerImpressions || "(none)"}
Hints used: ${hintsUsed}

Produce a coaching scorecard. Assess correctness (based on test results), estimate
the time and space complexity of the final code, identify 2-3 specific strengths
(quote a moment from the transcript or reference a specific code choice), identify
2-3 areas to improve with a concrete suggestion each, note the quality of the
candidate's communication (did they explain their approach, ask clarifying
questions, discuss trade-offs), and give a realistic hire/no-hire verdict with
brief reasoning that factors in hints used.

Return ONLY valid JSON in this exact shape, no other text:
{
  "correctness": "...",
  "complexity": "...",
  "strengths": [{ "note": "..." }],
  "improvements": [{ "note": "...", "suggestion": "..." }],
  "communicationNote": "...",
  "verdict": "..."
}`;

  const res = await fetchWithTimeout(`${GEMINI_ENDPOINT}?key=${GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
    }),
  }, 30000);

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = await res.json();
  const parsed = parseJsonResponse(extractText(data));
  return {
    correctness: parsed.correctness || "Unknown",
    complexity: parsed.complexity || "Unknown",
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
    communicationNote: parsed.communicationNote || "",
    verdict: parsed.verdict || "",
  };
}
