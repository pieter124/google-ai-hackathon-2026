# Mock Interview Agent

A live coding-interview practice tool with an AI interviewer: voice (push-to-talk),
a real code editor, sandboxed test execution, and a research-backed coaching
scorecard. **No build step** — plain ES modules with React and CodeMirror loaded
from CDN, so it runs on any static file server.

## Run

Serve the folder over http(s) (module imports + Web Workers don't work from
`file://`). Any of these work:

```bash
python -m http.server 8000        # then open http://localhost:8000
# or, if you have Node:
npx serve . -l 8000
```

Set your Google API key once in the browser devtools console (it is read from
`localStorage`, so it is never committed):

```js
localStorage.GOOGLE_API_KEY = "YOUR_KEY"   // then reload
```

The key must be restricted (Google Cloud Console) to exactly the three APIs used:
**Gemini** (Generative Language), **Cloud Speech-to-Text**, **Cloud Text-to-Speech**.

## Three-agent architecture

- **Agent 1 — Interviewer** (`api/geminiClient.js` → `callGeminiInterviewTurn`):
  per turn (voice / run-code / nudge); returns the reply, updated private
  impressions, and a −1..+1 trajectory signal that drives the path chart.
- **Agent 2 — Aggregator** (`callGeminiCheckpoint`, timer in `InterviewScreen`):
  every ~2 min analyzes the window's transcript + keystroke activity, logging a
  progress signal — catches idle stretches no turn covered.
- **Agent 3 — Watchdog** (client heuristics in `InterviewScreen`): snapshots
  keystrokes every 3s and proactively nudges on a sustained stuck pattern
  (silent+idle, or filler-talk without progress).

Every turn and checkpoint also emits sanitized 1–5 updates for the five rubric
dimensions, shown live in the **Criteria Matrix** on the right rail (so scoring
is visible during the interview, not just at the end). All three agents write to
one timestamped `utils/sessionLog.js`; the end-of-session report merges the
signals into authoritative 1–5 rubric scores, an SVG **path curve**, and a
verdict.

See [`RESEARCH.md`](./RESEARCH.md) for the citations behind the rubric anchors,
interviewer behavior, and watchdog thresholds.

## Run modes

This branch (`Sali`) is **client-only and zero-setup** — matches the spec's
no-backend design and runs on any static server (above). The `main` branch also
ships an optional Express + Google **ADC** proxy (`server/`) that keeps the key
server-side; adopt that for a hardened/deployed build (it needs Node + `gcloud`
auth). For the demo, the client-only mode is the fast path.
