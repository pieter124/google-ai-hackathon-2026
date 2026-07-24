// Converts a recorded audio Blob (from MediaRecorder) into the raw base64
// payload used both for Gemini's native audio-understanding input and for
// the Cloud Speech-to-Text fallback.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read recorded audio."));
    reader.readAsDataURL(blob);
  });
}

// One shared AudioContext for the page's lifetime — browsers cap how many
// can exist at once, and we create a fresh <audio> element per reply anyway.
let sharedAudioContext = null;

// Exported so the hands-free voice loop (utils/voiceLoop.js) can hang its
// mic AnalyserNode off the same context the TTS playback graph uses — one
// context for the whole page, unlocked once by the Start-interview click.
export function getSharedAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!sharedAudioContext) sharedAudioContext = new AudioContextClass();
  return sharedAudioContext;
}

// Resume the shared context from inside a genuine user gesture. The context
// feeds the hands-free mic analyser and the offline amplitude decode below;
// resuming it early (Start-interview click, text submits) keeps both live.
export function unlockAudioContext() {
  const ctx = getSharedAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

// Offline amplitude envelope: RMS per 50ms window of the decoded reply, so
// the avatar can animate to the voice WITHOUT routing playback through the
// Web Audio graph. Routing through the graph is exactly what broke replies:
// Chrome's echo canceller only subtracts audio played by plain media
// elements, so graph-routed TTS leaked into the mic, the hands-free loop
// heard "speech", and barge-in cut the interviewer off half a second in.
const ENVELOPE_HZ = 20;

async function decodeAmplitudeEnvelope(base64Audio) {
  const ctx = getSharedAudioContext();
  if (!ctx) throw new Error("Web Audio unavailable");
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const decoded = await ctx.decodeAudioData(bytes.buffer);
  const samples = decoded.getChannelData(0);
  const windowSize = Math.floor(decoded.sampleRate / ENVELOPE_HZ);
  const envelope = new Float32Array(Math.ceil(samples.length / windowSize));
  for (let w = 0; w < envelope.length; w++) {
    const start = w * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    envelope[w] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return envelope;
}

// Prepares a base64-encoded audio reply (MP3 from Cloud Text-to-Speech) for
// playback through a PLAIN <audio> element — deliberately not Web Audio, so
// echo cancellation keeps it out of the mic (see above). `getLevel()`
// returns the voice's current amplitude (from the offline envelope, indexed
// by playback position) for the avatar animation. `finished` resolves
// exactly once, whether playback completed, errored, was blocked by the
// browser's autoplay policy, or was cut short by `stop()` (barge-in / Skip)
// — it never rejects, so a TTS/audio hiccup can never strand the UI (the
// interviewer's line is always shown as text too).
export function prepareAudioPlayback(base64Audio, mimeType = "audio/mp3") {
  let audio;
  try {
    audio = new Audio(`data:${mimeType};base64,${base64Audio}`);
  } catch (err) {
    return { audio: null, getLevel: () => 0, finished: Promise.resolve({ played: false }), stop: () => {} };
  }

  let envelope = null;
  decodeAmplitudeEnvelope(base64Audio)
    .then((env) => { envelope = env; })
    .catch(() => {}); // animation falls back to a gentle constant

  const getLevel = () => {
    if (audio.paused || audio.ended) return 0;
    if (!envelope) return 0.1;
    return envelope[Math.floor(audio.currentTime * ENVELOPE_HZ)] || 0;
  };

  let settled = false;
  let settleFn = null;
  const finished = new Promise((resolve) => {
    const settle = (played) => {
      if (settled) return;
      settled = true;
      resolve({ played });
    };
    settleFn = settle;
    audio.onended = () => settle(true);
    audio.onerror = () => settle(false);
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => settle(false));
    }
  });

  const stop = () => {
    try {
      audio.pause();
    } catch {}
    if (settleFn) settleFn(false);
  };

  return { audio, getLevel, finished, stop };
}
