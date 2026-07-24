// Local, free filler-word detector — no API call. Backs both the Watchdog's
// "talking but not getting anywhere" trigger and the final report's filler
// stats. Deliberately simple regex counting, not NLP: matches the spec's
// "local regex, free" line and the honest caveat that this is a coaching
// signal, not a rigorous fluency measurement.
const FILLER_PATTERNS = [
  /\bum+\b/gi,
  /\buh+\b/gi,
  /\bhmm+\b/gi,
  /\blike\b/gi,
  /\byou know\b/gi,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bi mean\b/gi,
];

// { fillerCount, totalWords, ratio } for one piece of candidate speech.
export function computeFillerStats(text) {
  const totalWords = (text.match(/\S+/g) || []).length;
  const fillerCount = FILLER_PATTERNS.reduce((count, pattern) => count + (text.match(pattern) || []).length, 0);
  const ratio = totalWords === 0 ? 0 : fillerCount / totalWords;
  return { fillerCount, totalWords, ratio };
}

// Aggregates filler stats across several candidate turns (e.g. the whole
// session for the final report, or the last few turns for the Watchdog).
export function aggregateFillerStats(texts) {
  const totals = texts.reduce(
    (acc, text) => {
      const { fillerCount, totalWords } = computeFillerStats(text);
      return { fillerCount: acc.fillerCount + fillerCount, totalWords: acc.totalWords + totalWords };
    },
    { fillerCount: 0, totalWords: 0 }
  );
  return { ...totals, ratio: totals.totalWords === 0 ? 0 : totals.fillerCount / totals.totalWords };
}
