// One-time asset generation: for each interviewer, create a portrait plus a
// short Veo talking loop animated from it, saved under assets/avatars/. The app
// prefers these over runtime generation and plays the loop while the TTS speaks.
//
// Usage:
//   node scripts/generate-avatar-videos.mjs maya   # one character
//   node scripts/generate-avatar-videos.mjs        # the whole cast
//
// Veo bills per second of video — run deliberately.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INTERVIEWERS, GEMINI_IMAGE_MODEL } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const ASSETS_DIR = path.join(REPO_ROOT, "assets", "avatars");

const VEO_MODEL = "veo-3.1-fast-generate-preview";
const VIDEO_SECONDS = 6;
const BASE = "https://generativelanguage.googleapis.com/v1beta";

const apiKey = (readFileSync(path.join(REPO_ROOT, ".env"), "utf8").match(/^GEMINI_API_KEY=(.+)$/m) || [])[1];
if (!apiKey) {
  console.error("GEMINI_API_KEY not found in .env — this script needs it to call Veo.");
  process.exit(1);
}

function videoPrompt(character) {
  return (
    `The exact person from the reference image — keep the flat vector illustration art style, colors, framing and ` +
    `dark navy background completely unchanged. Animate them talking calmly straight to camera, as if explaining ` +
    `something in a video call: natural continuous mouth movement, occasional blinks, subtle head motion. ` +
    `Static camera, centered head-and-shoulders composition. No text, no captions, no zoom, no background changes.`
  );
}

async function generatePortrait(character) {
  const res = await fetch(`${BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: character.avatarPrompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) throw new Error(`portrait generation failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
  if (!part) throw new Error("portrait generation returned no image");
  return Buffer.from(part.inlineData.data, "base64");
}

async function generateTalkingVideo(character, portraitJpeg) {
  const start = await fetch(`${BASE}/models/${VEO_MODEL}:predictLongRunning?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instances: [
        {
          prompt: videoPrompt(character),
          image: { bytesBase64Encoded: portraitJpeg.toString("base64"), mimeType: "image/jpeg" },
        },
      ],
      parameters: { aspectRatio: "16:9", durationSeconds: VIDEO_SECONDS },
    }),
  });
  if (!start.ok) throw new Error(`Veo start failed (${start.status}): ${(await start.text()).slice(0, 300)}`);
  const { name } = await start.json();
  console.log(`  Veo operation: ${name}`);

  // Poll the long-running operation until the clip is rendered.
  let op;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const poll = await fetch(`${BASE}/${name}?key=${apiKey}`);
    op = await poll.json();
    if (op.error) throw new Error(`Veo failed: ${JSON.stringify(op.error).slice(0, 300)}`);
    if (op.done) break;
    process.stdout.write(".");
  }
  console.log("");
  if (!op?.done) throw new Error("Veo timed out after 10 minutes");

  const resp = op.response || {};
  const sample =
    resp.generateVideoResponse?.generatedSamples?.[0]?.video ||
    resp.generatedVideos?.[0]?.video ||
    resp.videos?.[0];
  const uri = sample?.uri || sample?.videoUri;
  if (uri) {
    const dl = await fetch(uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${apiKey}`);
    if (!dl.ok) throw new Error(`video download failed (${dl.status})`);
    return Buffer.from(await dl.arrayBuffer());
  }
  const inline = sample?.bytesBase64Encoded || sample?.encodedVideo;
  if (inline) return Buffer.from(inline, "base64");
  throw new Error(`unrecognized Veo response shape: ${JSON.stringify(resp).slice(0, 400)}`);
}

const wanted = process.argv.slice(2);
const cast = wanted.length ? INTERVIEWERS.filter((c) => wanted.includes(c.id)) : INTERVIEWERS;
if (!cast.length) {
  console.error(`No matching characters. Known ids: ${INTERVIEWERS.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

mkdirSync(ASSETS_DIR, { recursive: true });
for (const character of cast) {
  console.log(`${character.name} (${character.id})`);
  const portraitPath = path.join(ASSETS_DIR, `${character.id}.jpg`);
  let portrait;
  if (existsSync(portraitPath)) {
    portrait = readFileSync(portraitPath);
    console.log("  portrait: reusing existing asset");
  } else {
    portrait = await generatePortrait(character);
    writeFileSync(portraitPath, portrait);
    console.log(`  portrait: saved (${(portrait.length / 1024).toFixed(0)}KB)`);
  }
  const videoPath = path.join(ASSETS_DIR, `${character.id}-talking.mp4`);
  if (existsSync(videoPath)) {
    console.log("  video: already exists, skipping (delete it to regenerate)");
    continue;
  }
  const video = await generateTalkingVideo(character, portrait);
  writeFileSync(videoPath, video);
  console.log(`  video: saved (${(video.length / 1024 / 1024).toFixed(1)}MB)`);
}
console.log("Done.");
