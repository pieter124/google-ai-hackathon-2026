# Mock Interview Agent

A live coding-interview practice tool. You solve a LeetCode-style problem in a real code editor
while an AI interviewer (three coordinated agents — Interviewer, Aggregator, Watchdog) watches,
listens, and reacts in character, then gives a coaching scorecard at the end.

The frontend is a zero-build static app (plain ES modules, React + CodeMirror 6 loaded from CDN —
no `npm install` needed to edit it, no bundler). A small Express server proxies the three Google
calls (Gemini reasoning + native audio-out, Cloud Speech-to-Text fallback) so no API key ever
lives in the browser — it authenticates upstream via either a plain Gemini API key or
**Application Default Credentials**, your choice.

## One-time setup

1. **Configure credentials** — pick one:
   ```bash
   cp .env.example .env
   ```
   - **Option A (simplest): API key.** Grab a key from
     [Google AI Studio](https://aistudio.google.com/apikey), then in `.env` set:
     ```
     GEMINI_API_KEY=your-key-here
     ```
     That's it for Gemini — no GCP project or `gcloud` needed.
   - **Option B: Application Default Credentials.** Leave `GEMINI_API_KEY` unset, set
     `GCP_PROJECT_ID` in `.env` to a GCP project with the **Vertex AI API** enabled, then run:
     ```bash
     bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)
     ```
     (equivalent to `gcloud auth application-default login`).

   Either way, the **Cloud Speech-to-Text** fallback path (used only when Gemini's native audio
   input rejects the browser's recording format) always needs Option B — an AI Studio key isn't
   scoped for that API. Fine to skip if you're just trying things out with Option A.

2. **Install server dependencies**:
   ```bash
   npm install
   ```

## Run it

```bash
npm start
```

Open **http://localhost:8000** in **Chrome** (voice capture assumes Chrome/Edge/Firefox's
WebM/Opus recording format — Safari uses a different codec).

To confirm ADC is wired up correctly without going through the whole interview flow:
```bash
curl http://localhost:8000/api/health
```

## How it works

- Pick a persona (Supportive / Rigorous) and a session length; the problem itself is chosen for
  you by a weighted randomizer (~10% easy / ~45% medium / ~45% hard).
- Push-to-talk voice sends your recording straight into Gemini's native audio understanding; if
  Gemini rejects the browser's recording format, it automatically falls back to Cloud
  Speech-to-Text and retries with the transcribed text.
- The interviewer's spoken replies come from Gemini's own text-to-speech (no separate TTS API).
- A live Criteria Matrix updates as you go, fed by per-turn updates (Agent 1), periodic
  windowed checkpoints (Agent 2 / Aggregator), and proactive nudges when you seem stuck
  (Agent 3 / Watchdog).
- "Run Code" executes your solution against curated test cases in a sandboxed Web Worker.
- At the end, a coaching scorecard merges everything: criteria scores, a path narrative, local
  filler-word stats, correctness/complexity, and a hire/no-hire verdict.

## Troubleshooting

- **"No Application Default Credentials found"** — re-run the `setup_adc.sh` command above, then
  restart `npm start`.
- **Speech-to-Text quota/billing-project errors** — run
  `gcloud auth application-default set-quota-project YOUR_PROJECT_ID`.
- **Gemini calls 404** — the TTS model name (`GEMINI_TTS_MODEL` in `src/config.js`) is a preview
  model; check it against current Gemini docs if it stops resolving.
