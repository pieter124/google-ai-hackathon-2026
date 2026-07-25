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

// Cloud Speech-to-Text, via the ADC-authenticated /api/speech-to-text proxy.
// Fallback only: we prefer sending audio straight to Gemini, and reach here
// when Gemini rejects the browser's webm/opus recording format.
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

// The reply sometimes carries code-ish notation despite the prompt asking for
// plain speech, and TTS would read the symbols out loud ("open bracket...").
// Rewrite it into what an engineer would say; only the audio is affected, the
// transcript keeps the original.
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
  // Operators → words, before the symbol sweep below eats them.
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

// Cloud Text-to-Speech, via the ADC-authenticated /api/text-to-speech proxy.
// The interviewer's voice. Returns base64 MP3; the caller always keeps the
// transcript rendered too, in case autoplay is blocked.
export async function textToSpeech(rawText, voiceName = "en-US-Chirp3-HD-Aoede") {
  const text = toSpeakableText(rawText);
  // 30s rather than the default: the opening reads the whole problem aloud.
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
