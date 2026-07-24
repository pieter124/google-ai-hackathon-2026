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

// The interviewer's reply sometimes carries code-ish notation (backticks,
// brackets, operators) despite the prompt asking for plain speech — and TTS
// reads those symbols out loud ("open bracket... comma..."). This rewrites
// the text into what an engineer would actually SAY, and strips the rest.
// Only the audio gets this treatment; the transcript shows the original.
function toSpeakableText(text) {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, " "); // never read code blocks aloud
  t = t.replace(/`([^`]*)`/g, "$1");
  // Complexity notation first, while its parentheses still exist.
  t = t.replace(/\bO\(([^)]*)\)/g, (_, inner) => {
    const spoken = inner
      .replace(/\^2/g, " squared")
      .replace(/\^3/g, " cubed")
      .replace(/\*/g, " times ")
      .replace(/·/g, " times ");
    return ` big O of ${spoken} `;
  });
  // Operators → words (before the symbol sweep below eats them).
  t = t
    .replace(/===|==/g, " equals ")
    .replace(/!==|!=/g, " not equal to ")
    .replace(/<=/g, " less than or equal to ")
    .replace(/>=/g, " greater than or equal to ")
    .replace(/->|→/g, " to ")
    .replace(/&&/g, " and ")
    .replace(/\|\|/g, " or ")
    .replace(/\^2\b/g, " squared")
    .replace(/\+/g, " plus ")
    .replace(/&/g, " and ");
  // Brackets/braces/quotes and markdown leftovers become pauses or vanish;
  // sentence punctuation stays — TTS uses it for prosody, silently.
  t = t.replace(/[[\]{}()<>]/g, ", ");
  t = t.replace(/[#*_~|\\/="“”‘’]/g, " ");
  t = t.replace(/\s*,(\s*,)+/g, ", ").replace(/,\s*([.?!])/g, "$1");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
  return t;
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
export async function textToSpeech(rawText, voiceName = "en-US-Chirp3-HD-Aoede") {
  const text = toSpeakableText(rawText);
  // 30s rather than the default 15s: the opening reads the whole problem
  // aloud, and synthesizing ~1min of speech can run long.
  const res = await fetchWithTimeout(
    "/api/text-to-speech",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: "en-US", name: voiceName },
        audioConfig: { audioEncoding: "MP3" },
      }),
    },
    30000
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Text-to-Speech error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = await res.json();
  if (!data.audioContent) throw new Error("Text-to-Speech returned no audio.");
  return data.audioContent; // base64 mp3
}
