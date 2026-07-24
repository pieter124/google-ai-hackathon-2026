// ---------------------------------------------------------------------------
// Thin ADC-authenticated proxy + static file server.
//
// The frontend used to call Google's Gemini / Speech-to-Text / Text-to-Speech
// REST APIs directly from the browser with an API key in the URL
// (`?key=...`). That key had to live in client-side source, which is why
// config.js used to warn it must be referrer-restricted.
//
// Now the browser only ever talks to this same-origin server. This process
// holds no secret of its own — it obtains a short-lived OAuth token via
// Application Default Credentials (see googleAuth.js) and attaches it to
// each upstream request. The three routes below are intentionally thin:
// each one takes the exact JSON body the frontend already builds (unchanged
// from before), forwards it to the real Google endpoint with that token, and
// pipes the response straight back.
// ---------------------------------------------------------------------------
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, GCP_PROJECT_ID, GCP_LOCATION, GEMINI_MODEL, GEMINI_API_KEY } from "./config.js";
import { getAuthClient, getProjectId, AdcError } from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "20mb" })); // base64 audio clips push past express's small default limit

// Forwards `body` to `url` with an ADC-derived bearer token, and mirrors
// whatever Google returns (status + body) straight back to the caller so
// the frontend's existing `if (!res.ok)` error handling keeps working
// unchanged.
async function proxy(res, url, body) {
  try {
    const client = await getAuthClient();
    const upstream = await client.request({ url, method: "POST", data: body });
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    if (err instanceof AdcError) {
      return res.status(500).json({ error: err.message });
    }
    // google-auth-library (via gaxios) throws on non-2xx responses with the
    // upstream status/body attached — surface those rather than a bare 500.
    const status = err.response?.status || 500;
    const data = err.response?.data;
    res.status(status).json(data || { error: err.message });
  }
}

// Forwards `body` to a generativelanguage.googleapis.com model using a plain
// AI Studio API key (?key=...) instead of an ADC bearer token — the
// alternative path used when GEMINI_API_KEY is set. Mirrors `proxy()`'s
// status/body passthrough so the frontend's error handling stays unchanged.
async function proxyWithApiKey(res, url, body) {
  try {
    const upstream = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GOOGLE API CALL SITE 1 — Gemini reasoning (interview turns, checkpoints,
// scorecard). Two auth modes, picked at request time:
//   - GEMINI_API_KEY set: generativelanguage.googleapis.com with a plain AI
//     Studio API key, no GCP project/ADC needed for this route.
//   - otherwise: Vertex AI's OAuth-based endpoint over ADC (GCP_PROJECT_ID
//     required).
// Same request/response shape either way (contents/generationConfig in,
// candidates[].content.parts[].text out). Pass `model` in the body to
// override the default GEMINI_MODEL from src/config.js. Voice output does
// NOT go through this route — see /api/text-to-speech below.
app.post("/api/gemini/generate", async (req, res) => {
  const { model, ...body } = req.body || {};
  const modelId = model || GEMINI_MODEL;

  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
    return proxyWithApiKey(res, url, body);
  }

  if (!GCP_PROJECT_ID) {
    return res.status(500).json({
      error: "Neither GEMINI_API_KEY nor GCP_PROJECT_ID is set. Copy .env.example to .env and fill one of them in.",
    });
  }
  const url =
    `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}` +
    `/locations/${GCP_LOCATION}/publishers/google/models/${modelId}:generateContent`;
  await proxy(res, url, body);
});

// GOOGLE API CALL SITE 2 — Cloud Speech-to-Text. Fallback path (used when
// Gemini's native audio-understanding input rejects the browser's recording
// format). Unlike Gemini, this API rejects API-key auth outright ("API keys
// are not supported by this API" — confirmed against the live API, not just
// undocumented) — it always needs a real OAuth2 principal, so this route
// always goes through ADC regardless of whether GEMINI_API_KEY is set.
app.post("/api/speech-to-text", async (req, res) => {
  await proxy(res, "https://speech.googleapis.com/v1/speech:recognize", req.body);
});

// GOOGLE API CALL SITE 3 — Cloud Text-to-Speech. Agent 1's voice output.
// Same story as Speech-to-Text above: API keys aren't accepted by this API
// at all, so it's ADC-only no matter what GEMINI_API_KEY is set to.
app.post("/api/text-to-speech", async (req, res) => {
  await proxy(res, "https://texttospeech.googleapis.com/v1/text:synthesize", req.body);
});

// Quick way to confirm auth is wired up correctly without going through the
// whole interview flow: `curl localhost:8000/api/health`.
app.get("/api/health", async (_req, res) => {
  if (GEMINI_API_KEY) {
    return res.json({ ok: true, authMode: "api-key" });
  }
  try {
    await getAuthClient();
    const projectId = await getProjectId();
    res.json({ ok: true, authMode: "adc", adcProjectId: projectId || null, configuredProjectId: GCP_PROJECT_ID || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof AdcError ? err.message : err.message });
  }
});

// Serves the existing static frontend (index.html, src/**) — the same files
// `npx serve .` used to serve — from this one process, so the frontend and
// the /api/* proxy share an origin and no CORS setup is needed.
app.use(express.static(REPO_ROOT));

app.listen(PORT, () => {
  console.log(`Mock interview agent running at http://localhost:${PORT}`);
  if (GEMINI_API_KEY) {
    console.log(
      "Using GEMINI_API_KEY for all Google calls (Gemini, Speech-to-Text, Text-to-Speech). " +
        "If Speech-to-Text/Text-to-Speech 500 with an ADC error, this key isn't scoped for those APIs yet."
    );
  } else if (!GCP_PROJECT_ID) {
    console.warn("⚠️  Neither GEMINI_API_KEY nor GCP_PROJECT_ID is set — Gemini calls will fail until you set one in .env");
  }
});
