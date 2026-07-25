// Recorded Blob → raw base64, for both Gemini's audio input and the STT fallback.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read recorded audio."));
    reader.readAsDataURL(blob);
  });
}

// One shared AudioContext for the page's lifetime — browsers cap how many can
// exist at once.
let sharedAudioContext = null;

// Shared so the voice loop's mic analyser and the amplitude decode below use
// the same context, unlocked once by the Start-interview click.
export function getSharedAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!sharedAudioContext) sharedAudioContext = new AudioContextClass();
  return sharedAudioContext;
}

// Resume the shared context from inside a user gesture (Start click, text
// submit) so the mic analyser and amplitude decode stay live.
export function unlockAudioContext() {
  const ctx = getSharedAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

// Offline amplitude envelope (RMS per 50ms window) so the avatar can animate to
// the voice without routing playback through Web Audio. Routing it through the
// graph would leak past echo cancellation into the mic and trigger false barge-in.
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

// Plays a base64 MP3 reply through a plain <audio> element (not Web Audio, so
// echo cancellation keeps it out of the mic). `getLevel()` returns the current
// amplitude from the offline envelope for the avatar. `finished` resolves once
// however playback ends (completed, errored, autoplay-blocked, or stopped) and
// never rejects, so an audio hiccup can't strand the UI.
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
