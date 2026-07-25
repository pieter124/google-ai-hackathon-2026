// ADC-authenticated proxy plus static file server. The browser only talks to
// this same-origin server, which attaches a short-lived OAuth token (or an API
// key for Gemini) and forwards each request to the real Google endpoint, so no
// credential ever reaches the client.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, GCP_PROJECT_ID, GCP_LOCATION, GEMINI_MODEL, GEMINI_API_KEY } from "./config.js";
import { getAuthClient, getProjectId, AdcError } from "./googleAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const app = express();
app.use(express.json({ limit: "20mb" })); // base64 audio clips exceed the default limit

// Forwards `body` to `url` with an ADC bearer token and mirrors Google's
// status + body straight back.
async function proxy(res, url, body) {
  try {
    const client = await getAuthClient();
    const upstream = await client.request({ url, method: "POST", data: body });
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    if (err instanceof AdcError) {
      return res.status(500).json({ error: err.message });
    }
    // gaxios throws on non-2xx with the upstream status/body attached — surface
    // those rather than a bare 500.
    const status = err.response?.status || 500;
    const data = err.response?.data;
    res.status(status).json(data || { error: err.message });
  }
}

// Same as proxy(), but authenticates to generativelanguage.googleapis.com with
// a plain AI Studio API key (?key=...) — the path used when GEMINI_API_KEY is set.
async function proxyWithApiKey(res, url, body) {
  try {
    const upstream = await fetch(`${url}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Google sometimes answers errors with non-JSON (HTML, plain text). Parse
    // defensively so the real upstream status flows through — the audio→STT
    // fallback keys on the 400, which a blanket 500 would mask.
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text || upstream.statusText };
    }
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Gemini reasoning (interview turns, checkpoints, scorecard). Two auth modes,
// picked per request: an AI Studio API key when GEMINI_API_KEY is set, else
// Vertex AI over ADC. Same request/response shape either way; pass `model` in
// the body to override the default.
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

// Cloud Speech-to-Text — the fallback when Gemini rejects the browser's
// recording format. This API rejects API keys, so it's always ADC.
app.post("/api/speech-to-text", async (req, res) => {
  await proxy(res, "https://speech.googleapis.com/v1/speech:recognize", req.body);
});

// Cloud Text-to-Speech — the interviewer's voice. ADC only, same as STT.
app.post("/api/text-to-speech", async (req, res) => {
  await proxy(res, "https://texttospeech.googleapis.com/v1/text:synthesize", req.body);
});

// Confirms auth is wired up without running a full interview: curl /api/health.
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

// Serve the static frontend from the same process, so it shares an origin with
// the /api/* proxy and needs no CORS setup.
app.use(express.static(REPO_ROOT));

app.listen(PORT, () => {
  console.log(`Mock interview agent running at http://localhost:${PORT}`);
  if (GEMINI_API_KEY) {
    console.log(
      "Using GEMINI_API_KEY for Gemini calls. Speech-to-Text and Text-to-Speech don't accept " +
        "API keys at all, though — they always need ADC (see README) regardless of this setting."
    );
  } else if (!GCP_PROJECT_ID) {
    console.warn("⚠️  Neither GEMINI_API_KEY nor GCP_PROJECT_ID is set — Gemini calls will fail until you set one in .env");
  }
});
