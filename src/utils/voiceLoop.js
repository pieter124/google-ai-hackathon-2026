import { getSharedAudioContext } from "./audio.js";

// ---------------------------------------------------------------------------
// HANDS-FREE VOICE LOOP — replaces push-to-talk. The mic stream stays open
// for the whole interview; a lightweight local voice-activity detector (RMS
// of the analyser's time-domain samples, polled every 50ms) decides when the
// candidate started and stopped talking, and emits each finished utterance
// as a Blob through `onUtterance` — from there the existing pipeline is
// unchanged (Gemini native audio-in, Speech-to-Text fallback on 400).
//
// Turn-taking rules live in the caller: it calls `hold()` while a turn is
// processing or the interviewer is speaking (so the loop never records the
// TTS reply — echoCancellation helps, holding guarantees it) and `resume()`
// when the floor is the candidate's again. `setMuted` is the user-facing
// kill switch. All detection thresholds are tunable below.
// ---------------------------------------------------------------------------

const SPEECH_RMS_THRESHOLD = 0.02; // RMS of normalized [-1, 1] samples
const SPEECH_START_MS = 150; // sustained sound before we call it speech
const SPEECH_END_MS = 1500; // sustained silence before the utterance is done
const MIN_UTTERANCE_MS = 400; // discard blips shorter than this
const MIN_UTTERANCE_BYTES = 1500; // and blobs too tiny to hold real speech
const POLL_MS = 50;

function pickRecorderMimeType() {
  const preferred = "audio/webm;codecs=opus";
  return typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(preferred)
    ? preferred
    : "";
}

// Statuses reported via onStatusChange:
//   "listening"  — idle, watching for speech
//   "capturing"  — candidate is talking, recorder running
//   "held"       — paused by the caller (turn processing / TTS playing)
//   "muted"      — paused by the user
export function createVoiceLoop({ onUtterance, onLevel, onStatusChange }) {
  let stream = null;
  let sourceNode = null;
  let analyser = null;
  let samples = null;
  let pollTimer = null;

  let recorder = null;
  let chunks = [];
  let capturing = false;
  let captureStartedAt = 0;
  let aboveMs = 0;
  let belowMs = 0;

  let held = false;
  let muted = false;
  let stopped = false;
  let status = null;

  function setStatus(next) {
    if (status !== next) {
      status = next;
      if (onStatusChange) onStatusChange(next);
    }
  }

  function idleStatus() {
    setStatus(muted ? "muted" : held ? "held" : "listening");
  }

  // Throws if the user denies mic permission (or no mic exists) — caller is
  // expected to catch this and run the session as text-only.
  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = getSharedAudioContext();
    if (!ctx) throw new Error("Web Audio is not available in this browser.");
    // With an active capture stream Chrome permits resuming without a fresh
    // gesture; without this the analyser reads silence forever.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    sourceNode = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser); // analysis only — never wired to destination
    samples = new Float32Array(analyser.fftSize);
    pollTimer = setInterval(poll, POLL_MS);
    idleStatus();
  }

  function poll() {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    if (onLevel) onLevel(rms);

    if (muted || held) {
      if (capturing) cancelCapture();
      aboveMs = 0;
      belowMs = 0;
      return;
    }

    if (!capturing) {
      if (rms >= SPEECH_RMS_THRESHOLD) {
        aboveMs += POLL_MS;
        if (aboveMs >= SPEECH_START_MS) beginCapture();
      } else {
        aboveMs = 0;
      }
    } else {
      if (rms < SPEECH_RMS_THRESHOLD) {
        belowMs += POLL_MS;
        if (belowMs >= SPEECH_END_MS) endCapture();
      } else {
        belowMs = 0;
      }
    }
  }

  function beginCapture() {
    const mimeType = pickRecorderMimeType();
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (err) {
      console.warn("Voice capture failed to start:", err.message);
      return;
    }
    chunks = [];
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.start(250); // timeslice so chunks flow even for long utterances
    capturing = true;
    captureStartedAt = Date.now();
    aboveMs = 0;
    belowMs = 0;
    setStatus("capturing");
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      const rec = recorder;
      recorder = null;
      if (!rec || rec.state === "inactive") {
        resolve(null);
        return;
      }
      rec.addEventListener(
        "stop",
        () => resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" })),
        { once: true }
      );
      rec.stop();
    });
  }

  function endCapture() {
    capturing = false;
    // The utterance proper ended SPEECH_END_MS ago — the tail is silence.
    const spokenMs = Date.now() - captureStartedAt - SPEECH_END_MS;
    stopRecorder().then((blob) => {
      if (blob && spokenMs >= MIN_UTTERANCE_MS && blob.size >= MIN_UTTERANCE_BYTES) {
        onUtterance(blob);
      }
    });
    idleStatus();
  }

  function cancelCapture() {
    capturing = false;
    stopRecorder(); // discard the blob
  }

  // Caller-controlled pause: while a turn is in flight or TTS is playing.
  function hold() {
    held = true;
    if (capturing) cancelCapture();
    idleStatus();
  }

  function resume() {
    held = false;
    aboveMs = 0;
    belowMs = 0;
    idleStatus();
  }

  function setMuted(next) {
    muted = next;
    if (capturing) cancelCapture();
    idleStatus();
  }

  function stop() {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    if (capturing) cancelCapture();
    if (sourceNode) sourceNode.disconnect();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  return { start, hold, resume, setMuted, stop };
}
