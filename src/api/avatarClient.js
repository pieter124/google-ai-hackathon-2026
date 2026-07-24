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

// Avatars render at 56px but come back from the model at ~1024px / ~500KB
// of base64 — downscaling before caching keeps 12 cached frames (4 cast
// members × 3 frames) comfortably inside the ~5MB localStorage quota.
// Falls back to the original on any canvas hiccup.
function downscaleDataUri(dataUri, size = 256, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        canvas.getContext("2d").drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch {
        resolve(dataUri);
      }
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

async function callImageModel(parts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("/api/gemini/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    if (!res.ok) throw new Error(`Avatar generation failed (${res.status})`);
    const data = await res.json();
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find((p) => p.inlineData?.data);
    if (!imagePart) throw new Error("Avatar generation returned no image.");
    const dataUri = `data:${imagePart.inlineData.mimeType || "image/jpeg"};base64,${imagePart.inlineData.data}`;
    return downscaleDataUri(dataUri);
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Avatar generation timed out.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function generateAvatar(character) {
  return callImageModel([{ text: character.avatarPrompt }]);
}

// ---------------------------------------------------------------------------
// Pre-generated static assets (scripts/generate-avatar-videos.mjs) win over
// runtime generation: if assets/avatars/<id>.jpg exists it IS the portrait
// (and the Veo talking loop <id>-talking.mp4 was animated from that exact
// image, so face and video always match). Probed once per id, then cached.
// ---------------------------------------------------------------------------
const assetProbes = new Map();

function probeAsset(url) {
  if (!assetProbes.has(url)) {
    assetProbes.set(
      url,
      fetch(url, { method: "HEAD" })
        .then((res) => (res.ok ? url : null))
        .catch(() => null)
    );
  }
  return assetProbes.get(url);
}

// Resolves to the URL of the character's pre-generated talking-loop video,
// or null when none was generated — callers fall back to frame animation.
export function getAvatarVideoUrl(character) {
  return probeAsset(`/assets/avatars/${character.id}-talking.mp4`);
}

// Variant generation needs the base image as raw base64 even when the base
// is a static asset URL rather than a data URI.
async function asDataUri(src) {
  if (src.startsWith("data:")) return src;
  const blob = await (await fetch(src)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read avatar asset."));
    reader.readAsDataURL(blob);
  });
}

// Resolves to an image source for the character's portrait — a static asset
// URL when one was pre-generated, else from cache, else freshly generated
// (and cached). Rejects only when generation genuinely failed; callers show
// their initials fallback in that case.
export async function getAvatar(character) {
  const asset = await probeAsset(`/assets/avatars/${character.id}.jpg`);
  if (asset) return asset;

  const cached = readCache(character.id);
  if (cached) return cached;

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

// ---------------------------------------------------------------------------
// Animation frames — the same character re-generated by the image model in
// two more poses via image editing (base portrait passed back in as input,
// verified to stay near pixel-identical). AvatarOrb swaps these live off the
// speech amplitude: mouth-open while the voice is loud, eyes-closed for
// blinks. Cached like the base portrait, generated lazily on first use.
// ---------------------------------------------------------------------------
const VARIANT_PROMPTS = {
  talking:
    "Edit this illustration: the EXACT same character, art style, colors, framing and background — the only change is the mouth is open mid-speech, as if actively talking. Keep everything else identical.",
  blink:
    "Edit this illustration: the EXACT same character, art style, colors, framing and background — the only change is the eyes are fully closed mid-blink, with a calm relaxed face. Keep everything else identical.",
};

export function getAvatarVariant(character, variant) {
  const prompt = VARIANT_PROMPTS[variant];
  if (!prompt) return Promise.reject(new Error(`Unknown avatar variant: ${variant}`));
  const flightKey = `${character.id}:${variant}`;

  if (!inFlight.has(flightKey)) {
    const promise = getAvatar(character)
      .then(async (base) => {
        // The cache key carries the portrait's provenance: a variant built
        // from the runtime-generated portrait must never be served next to
        // a pre-generated asset portrait (different face) — and vice versa.
        const cacheKey = base.startsWith("data:") ? flightKey : `${flightKey}@asset`;
        const cached = readCache(cacheKey);
        if (cached) return cached;
        const [meta, data] = (await asDataUri(base)).split(",");
        const mimeType = (meta.match(/^data:([^;]+)/) || [])[1] || "image/jpeg";
        const dataUri = await callImageModel([{ text: prompt }, { inlineData: { mimeType, data } }]);
        writeCache(cacheKey, dataUri);
        return dataUri;
      })
      .finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
  }
  return inFlight.get(flightKey);
}
