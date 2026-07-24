async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE — Cloud Speech-to-Text (via the ADC-authenticated
// /api/speech-to-text proxy, see server/server.js)
//
// Fallback path only: Agent 1 prefers sending the candidate's recorded audio
// straight into the Gemini reasoning call (native audio understanding — see
// geminiClient.js). Gemini's documented audio-input formats don't include
// webm/opus, which is what Chrome's MediaRecorder actually produces, so if
// that direct call 400s, InterviewScreen falls back to this call to get a
// text transcript and retries the same Gemini turn with text instead.
// ---------------------------------------------------------------------------
export async function speechToText(base64Audio) {
  const res = await fetchWithTimeout("/api/speech-to-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: {
        encoding: "WEBM_OPUS",
        languageCode: "en-US",
        model: "default",
      },
      audio: { content: base64Audio },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Speech-to-Text error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = await res.json();
  const transcript = (data.results || [])
    .map((r) => r.alternatives?.[0]?.transcript || "")
    .join(" ")
    .trim();

  if (!transcript) {
    throw new Error("No speech was recognized — try again and speak a bit louder/clearer.");
  }
  return transcript;
}

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE — Cloud Text-to-Speech (via the ADC-authenticated
// /api/text-to-speech proxy, see server/server.js)
//
// Agent 1's voice output. Returns base64-encoded MP3 bytes; the caller
// (InterviewScreen, via utils/audio.js's prepareAudioPlayback) plays it and
// always keeps the text transcript rendered too, in case autoplay is
// blocked.
// ---------------------------------------------------------------------------
export async function textToSpeech(text, voiceName = "en-US-Neural2-D") {
  const res = await fetchWithTimeout("/api/text-to-speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "en-US", name: voiceName },
      audioConfig: { audioEncoding: "MP3" },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Text-to-Speech error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = await res.json();
  if (!data.audioContent) throw new Error("Text-to-Speech returned no audio.");
  return data.audioContent; // base64 mp3
}
