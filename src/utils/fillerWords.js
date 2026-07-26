// Local, free filler-word analysis — no API call. Two consumers:
//   1. The Watchdog, to detect "talking without progress" in near-real-time.
//   2. The end-of-session report, for a fluency stat the LLM doesn't have to
//      estimate (a hard count is more honest than a model guess).
//
// Research caveat carried from the spec: paralinguistic signals like filler
// rate can penalize non-native speakers and speech differences, so this is
// surfaced as a coaching signal, never a hard gate.

// Multi-word fillers must be matched before single words, and we match on word
// boundaries so "like" inside "unlike" doesn't count.
const FILLER_PATTERNS = [
  /\byou know\b/gi,
  /\bi mean\b/gi,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
  /\bi guess\b/gi,
  /\bum+\b/gi,
  /\buh+\b/gi,
  /\ber+\b/gi,
  /\bah+\b/gi,
  /\blike\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bliterally\b/gi,
  /\bright\b/gi,
];

// Returns { total, fillers, ratio } for a chunk of transcribed speech.
export function analyzeFillers(text) {
  const clean = (text || "").trim();
  if (!clean) return { total: 0, fillers: 0, ratio: 0 };
  const total = clean.split(/\s+/).length;
  let fillers = 0;
  for (const pattern of FILLER_PATTERNS) {
    const matches = clean.match(pattern);
    if (matches) fillers += matches.length;
  }
  return { total, fillers, ratio: total ? fillers / total : 0 };
}

// Filler ratio across the most recent candidate turns only — what the Watchdog
// watches. `text` is expected to already be the concatenation of recent
// candidate speech.
export function recentFillerRatio(text) {
  return analyzeFillers(text).ratio;
}
