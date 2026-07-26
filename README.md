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

All three write to one timestamped `utils/sessionLog.js`; the end-of-session
report merges the signals into 1–5 rubric scores + a path narrative.

See [`RESEARCH.md`](./RESEARCH.md) for the citations behind the rubric anchors,
interviewer behavior, and watchdog thresholds.
