import { GEMINI_IMAGE_MODEL } from "../config.js";

// ---------------------------------------------------------------------------
// GOOGLE API CALL SITE — Gemini image generation, via the same same-origin
// /api/gemini/generate proxy every reasoning call uses (the server just
// forwards whatever `model` we pass). Each interviewer's portrait is
// generated at most once per browser: the resulting data URI is cached in
// localStorage, so refreshes (and every later session) render instantly and
// cost nothing. Callers are expected to treat any failure here as cosmetic —
// SetupScreen falls back to an initials avatar and never blocks on this.
// ---------------------------------------------------------------------------
const CACHE_PREFIX = "avatar:v1:";

// Image generation is slow (~5-20s); comfortably above that, but not forever.
const TIMEOUT_MS = 45000;

// De-dupes concurrent requests for the same character (e.g. the setup screen
// unmounting and remounting mid-generation) so one portrait is never paid
// for twice.
const inFlight = new Map();

function readCache(id) {
  try {
    return localStorage.getItem(CACHE_PREFIX + id);
  } catch {
    return null; // storage disabled — just regenerate next time
  }
}

function writeCache(id, dataUri) {
  try {
    localStorage.setItem(CACHE_PREFIX + id, dataUri);
  } catch {
    // Quota exceeded or storage disabled — the avatar still renders this
    // session, it just won't be cached.
  }
}

async function generateAvatar(character) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("/api/gemini/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        contents: [{ role: "user", parts: [{ text: character.avatarPrompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    if (!res.ok) throw new Error(`Avatar generation failed (${res.status})`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData?.data);
    if (!imagePart) throw new Error("Avatar generation returned no image.");
    return `data:${imagePart.inlineData.mimeType || "image/jpeg"};base64,${imagePart.inlineData.data}`;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Avatar generation timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves to a data URI for the character's portrait — from cache when
// possible, generating (and caching) otherwise. Rejects only when generation
// genuinely failed; callers show their initials fallback in that case.
export function getAvatar(character) {
  const cached = readCache(character.id);
  if (cached) return Promise.resolve(cached);

  if (!inFlight.has(character.id)) {
    const promise = generateAvatar(character)
      .then((dataUri) => {
        writeCache(character.id, dataUri);
        return dataUri;
      })
      .finally(() => inFlight.delete(character.id));
    inFlight.set(character.id, promise);
  }
  return inFlight.get(character.id);
}
