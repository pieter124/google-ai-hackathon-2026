import { getSharedAudioContext } from "./audio.js";

// Hands-free voice loop. The mic stays open all session; a local voice-activity
// detector (RMS of the analyser's samples, polled every 50ms) decides when the
// candidate starts and stops talking and emits each utterance as a Blob through
// `onUtterance`. Turn-taking lives in the caller: `hold()` while a turn is
// processing or the interviewer is speaking, `resume()` when the floor is the
// candidate's, `setMuted` as the user kill switch.

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

// Statuses via onStatusChange: "listening" (idle), "capturing" (recording),
// "held" (paused by caller), "muted" (paused by user). onSpeechStart fires when
// capture begins — the caller uses it for barge-in.
export function createVoiceLoop({ onUtterance, onLevel, onStatusChange, onSpeechStart }) {
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
  // Capture-start threshold multiplier, raised while the reply plays so echo
  // residue can't pass for speech. Only start is boosted — end-of-utterance
  // detection stays at 1x so a real interruption's tail isn't chopped.
  let thresholdBoost = 1;

  function setStatus(next) {
    if (status !== next) {
      status = next;
      if (onStatusChange) onStatusChange(next);
    }
  }

  function idleStatus() {
    setStatus(muted ? "muted" : held ? "held" : "listening");
  }

  // Throws if mic permission is denied or none exists — caller runs text-only.
  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = getSharedAudioContext();
    if (!ctx) throw new Error("Web Audio is not available in this browser.");
    // An active capture stream lets Chrome resume without a fresh gesture;
    // without this the analyser reads silence forever.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    sourceNode = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    sourceNode.connect(analyser); // analysis only — never wired to output
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
      if (rms >= SPEECH_RMS_THRESHOLD * thresholdBoost) {
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
    recorder.start(250); // timeslice so chunks flow for long utterances
    capturing = true;
    captureStartedAt = Date.now();
    aboveMs = 0;
    belowMs = 0;
    setStatus("capturing");
    if (onSpeechStart) onSpeechStart();
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
    // The utterance ended SPEECH_END_MS ago; the tail is silence.
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

  // Caller-controlled pause while a turn is in flight or TTS is playing.
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

  function setThresholdBoost(next) {
    thresholdBoost = next;
  }

  function stop() {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    if (capturing) cancelCapture();
    if (sourceNode) sourceNode.disconnect();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }

  return { start, hold, resume, setMuted, setThresholdBoost, stop };
}
