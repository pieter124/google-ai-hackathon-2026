import { GOOGLE_API_KEY } from "../config.js";

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
// GOOGLE API CALL SITE 2 of 3 — Cloud Speech-to-Text (speech.googleapis.com)
//
// Takes the base64-encoded recording captured by MediaRecorder (WebM/Opus in
// Chrome/Edge/Firefox) and returns the recognized transcript text. Called
// once per push-to-talk turn, right after the candidate stops recording.
// ---------------------------------------------------------------------------
export async function speechToText(base64Audio) {
  const res = await fetchWithTimeout(`https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_API_KEY}`, {
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
// GOOGLE API CALL SITE 3 of 3 — Cloud Text-to-Speech (texttospeech.googleapis.com)
//
// Turns the interviewer's text response into spoken audio so the interview
// feels live. Returns base64-encoded MP3 bytes; the caller decodes/plays it
// (see utils/audio.js) and always keeps the text transcript rendered too, in
// case autoplay is blocked.
// ---------------------------------------------------------------------------
export async function textToSpeech(text, voiceName = "en-US-Neural2-D") {
  const res = await fetchWithTimeout(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_API_KEY}`, {
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
  return data.audioContent;
}
