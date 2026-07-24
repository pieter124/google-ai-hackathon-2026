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

// Once an <audio> element is routed through `createMediaElementSource` (see
// below, used for the avatar orb's amplitude data), its sound ONLY comes out
// via the Web Audio graph — the element's direct-to-speakers path is
// severed. That graph is silent whenever the AudioContext is "suspended",
// which is its default state until a genuine user gesture resumes it. Our
// TTS playback happens several awaited fetch calls after the mic click that
// started the turn, which can be too far removed from the click for the
// browser to still credit it as gesture-driven — so without this, replies
// can look like they're playing (no error, "speaking" state, onended fires)
// while producing zero sound. Call this synchronously from a click handler
// (see InterviewScreen's handleMicClick) to resume the context while it
// still counts as a gesture.
export function unlockAudioContext() {
  const ctx = getSharedAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

// Wires a Web Audio AnalyserNode to an <audio> element so the avatar orb can
// read live amplitude while a reply plays. `createMediaElementSource` may
// only be called once per element, which is fine: we build a brand new
// Audio() for every reply (see prepareAudioPlayback below).
function createAmplitudeAnalyser(audioEl) {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const source = ctx.createMediaElementSource(audioEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  return analyser;
}

// Prepares a base64-encoded audio reply (MP3 from Cloud Text-to-Speech) for
// playback, wiring it through an AnalyserNode so the avatar orb can read
// amplitude while it plays. Returns synchronously so the caller can start
// reading `analyser` immediately rather than waiting for playback to
// finish. `finished` resolves exactly once, whether playback completed,
// errored, or was blocked by the browser's autoplay policy — it never
// rejects, so a TTS/audio hiccup can never strand the UI (the interviewer's
// line is always shown as text too).
export function prepareAudioPlayback(base64Audio, mimeType = "audio/mp3") {
  let audio;
  let analyser = null;
  try {
    audio = new Audio(`data:${mimeType};base64,${base64Audio}`);
    try {
      analyser = createAmplitudeAnalyser(audio);
    } catch (err) {
      console.warn("Amplitude analyser unavailable:", err.message);
    }
  } catch (err) {
    return { audio: null, analyser: null, finished: Promise.resolve({ played: false }) };
  }

  const finished = new Promise((resolve) => {
    let settled = false;
    const settle = (played) => {
      if (settled) return;
      settled = true;
      resolve({ played });
    };
    audio.onended = () => settle(true);
    audio.onerror = () => settle(false);
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => settle(false));
    }
  });

  return { audio, analyser, finished };
}
