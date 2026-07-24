# Mock Interview Agent

A live coding-interview practice tool. You solve a LeetCode-style problem in a real code editor
while an AI interviewer (three coordinated agents — Interviewer, Aggregator, Watchdog) watches,
listens, and reacts in character, then gives a coaching scorecard at the end.

The frontend is a zero-build static app (plain ES modules, React + CodeMirror 6 loaded from CDN —
no `npm install` needed to edit it, no bundler). A small Express server proxies every Google call
(Gemini reasoning, Cloud Speech-to-Text, Cloud Text-to-Speech) so no credential ever lives in the
browser.

## One-time setup

1. **Configure credentials**:
   ```bash
   cp .env.example .env
   ```
   Gemini and the voice APIs need different auth:
   - **Gemini** (interview turns, checkpoints, scorecard) supports a plain API key — set
     `GEMINI_API_KEY` in `.env` and those calls need no `gcloud`/GCP project at all.
   - **Cloud Speech-to-Text** (voice-input fallback) and **Cloud Text-to-Speech** (the
     interviewer's spoken replies) **do not accept API keys at all** — confirmed against the live
     APIs, which reject them outright ("API keys are not supported by this API"). They always need
     **Application Default Credentials** (ADC), regardless of whether `GEMINI_API_KEY` is set. Set
     `GCP_PROJECT_ID` in `.env` to a project with the Vertex AI, Cloud Speech-to-Text, and Cloud
     Text-to-Speech APIs enabled, then run (one-time, installs/updates `gcloud` if needed):
     ```bash
     bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)
     ```
     (equivalent to `gcloud auth application-default login`.)

   **In short:** if you want voice at all, you need ADC set up. Setting `GEMINI_API_KEY` only
   shortcuts the reasoning calls; it doesn't remove the ADC requirement.

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

To confirm auth is wired up correctly without going through the whole interview flow:
```bash
curl http://localhost:8000/api/health
```

## How it works

- Pick a persona (Supportive / Rigorous) and a session length; the problem itself is chosen for
  you by a weighted randomizer (~10% easy / ~45% medium / ~45% hard).
- Push-to-talk voice sends your recording straight into Gemini's native audio understanding; if
  Gemini rejects the browser's recording format, it automatically falls back to Cloud
  Speech-to-Text and retries with the transcribed text.
- The interviewer's spoken replies come from Cloud Text-to-Speech.
- A live Criteria Matrix updates as you go, fed by per-turn updates (Agent 1), periodic
  windowed checkpoints (Agent 2 / Aggregator), and proactive nudges when you seem stuck
  (Agent 3 / Watchdog).
- "Run Code" executes your solution against curated test cases in a sandboxed Web Worker.
- At the end, a coaching scorecard merges everything: criteria scores, a path narrative, local
  filler-word stats, correctness/complexity, and a hire/no-hire verdict.

## Troubleshooting

- **"No Application Default Credentials found"** — re-run the `setup_adc.sh` command above, then
  restart `npm start`.
- **"API keys are not supported by this API"** — you're hitting Speech-to-Text or
  Text-to-Speech without ADC set up; see the setup section above, there's no API-key alternative
  for these two.
- **Speech-to-Text/Text-to-Speech quota/billing-project errors** — run
  `gcloud auth application-default set-quota-project YOUR_PROJECT_ID`.
- **Gemini calls 404** — the model name (`GEMINI_MODEL` in `.env`/`src/config.js`) may have been
  deprecated; check it against current Gemini docs.
