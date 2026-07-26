// The shared, timestamped session log from the architecture spec — the one
// place all three agents write to. Agent 1 logs turns, Agent 2 logs windowed
// checkpoints, Agent 3 logs nudges, and the editor logs keystroke/code/run
// snapshots. At session end the report call reads ONLY from here.
//
// Deliberately a plain factory (not React state): agents mutate it from timers
// and async callbacks where re-render-on-write would be noise. Anything that
// needs to render (the live transcript, the criteria matrix) keeps its own
// React state; this log is the analysis-and-report backbone, not a view model.
//
// Timestamps are stored relative to session start (`t`, in ms) so the path
// chart and report read as "time into the interview", independent of wall
// clock, and so the whole thing serializes cleanly for the report prompt.

export function createSessionLog(startedAtMs) {
  const start = startedAtMs;
  const events = []; // { t, kind, ... } appended in order

  function push(kind, payload) {
    events.push({ t: now(), kind, ...payload });
  }

  // ms since session start. Passed in from the caller's clock so the log has
  // no hidden dependency on Date.now() beyond this one spot.
  function now() {
    return Date.now() - start;
  }

  return {
    now,

    // --- Agent 1: Interviewer ---------------------------------------------
    // A conversational turn. `progress` is Agent 1's -1..+1 read of whether
    // the candidate just moved toward (+) or away from (-) a good solution;
    // it feeds the path chart. `source` distinguishes candidate/interviewer
    // and, for interviewer lines, whether it was a watchdog nudge.
    logTurn({ role, text, progress = null, source = "turn" }) {
      push("turn", { role, text, progress, source });
    },

    // --- Agent 2: Aggregator ----------------------------------------------
    logCheckpoint({ progress, note }) {
      push("checkpoint", { progress, note });
    },

    // --- Agent 3: Watchdog ------------------------------------------------
    logNudge({ reason, text }) {
      push("nudge", { reason, text });
    },

    // --- Editor / sandbox -------------------------------------------------
    // Called on the Watchdog cadence (~3s). `chars` is the current code
    // length so consumers can diff consecutive snapshots to see typing.
    logKeystrokeSnapshot({ chars }) {
      push("keystroke", { chars });
    },
    logRun({ passed, total }) {
      push("run", { passed, total });
    },

    // --- Reads ------------------------------------------------------------
    all() {
      return events;
    },
    // Events strictly after `sinceT` — the Aggregator's "this window" query.
    since(sinceT) {
      return events.filter((e) => e.t > sinceT);
    },
    // Ordered (t, progress) points from every turn/checkpoint that carried a
    // progress signal — the raw material for the path chart and path narrative.
    progressSeries() {
      return events
        .filter((e) => (e.kind === "turn" || e.kind === "checkpoint") && typeof e.progress === "number")
        .map((e) => ({ t: e.t, progress: e.progress }));
    },
    // Concatenated candidate speech since `sinceT` — the Watchdog's filler
    // input and the Aggregator's transcript slice.
    candidateSpeechSince(sinceT) {
      return events
        .filter((e) => e.kind === "turn" && e.role === "candidate" && e.t > sinceT)
        .map((e) => e.text)
        .join(" ");
    },
  };
}
