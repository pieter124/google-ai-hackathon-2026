// Local filler-word detector — no API call. Backs the watchdog's "talking but
// not progressing" trigger and the report's filler stats. Plain regex counting,
// a coaching signal rather than a rigorous fluency measure.
//
// Word boundaries matter — without them "like" fires inside "unlike". Some
// obvious-looking candidates are left out on purpose: "right" and "so" are
// ordinary words in technical speech ("the right pointer", "so we get O(n)"),
// and a false positive here doesn't just skew a stat, it feeds the watchdog's
// talking-without-progress trigger and can interrupt someone mid-explanation.
const FILLER_PATTERNS = [
  /\bum+\b/gi,
  /\buh+\b/gi,
  /\bhmm+\b/gi,
  /\berm*\b/gi,
  /\bah+\b/gi,
  /\blike\b/gi,
  /\byou know\b/gi,
  /\bi mean\b/gi,
  /\bi guess\b/gi,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bliterally\b/gi,
];

// { fillerCount, totalWords, ratio } for one piece of speech.
export function computeFillerStats(text) {
  const totalWords = (text.match(/\S+/g) || []).length;
  const fillerCount = FILLER_PATTERNS.reduce((count, pattern) => count + (text.match(pattern) || []).length, 0);
  const ratio = totalWords === 0 ? 0 : fillerCount / totalWords;
  return { fillerCount, totalWords, ratio };
}

// Aggregates filler stats across several turns (the whole session, or the last
// few for the watchdog).
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
