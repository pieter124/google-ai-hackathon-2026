// Converts a recorded audio Blob (from MediaRecorder) into the raw base64
// payload Cloud Speech-to-Text expects in `audio.content`.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read recorded audio."));
    reader.readAsDataURL(blob);
  });
}

// One shared AudioContext for the whole app. Created lazily on first playback
// (which always follows a user gesture, so autoplay policy is satisfied) and
// reused — browsers cap the number of live contexts, and one is all we need.
let sharedCtx = null;
function getAudioContext() {
  if (!sharedCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    sharedCtx = Ctor ? new Ctor() : null;
  }
  if (sharedCtx && sharedCtx.state === "suspended") sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

// Plays a base64 MP3 (from Cloud Text-to-Speech) and, while it plays, streams
// a normalized 0..1 amplitude to `onAmplitude` so the avatar can pulse in time
// with the voice. Routes through Web Audio for the amplitude tap; if that path
// fails it degrades to plain playback with no pulse.
//
// Returns a controller SYNCHRONOUSLY (not a bare promise) so the caller can
// pause/resume the interviewer mid-sentence and replay the last line:
//   { finished, pause, resume, isPaused }
// `finished` never rejects — browsers may block autoplay and the text is
// always shown as a caption too, so audio is a bonus, not a requirement.
export function playBase64Audio(base64Mp3, onAmplitude = () => {}) {
  const audio = new Audio(`data:audio/mp3;base64,${base64Mp3}`);

  let rafId = null;
  let done = false;
  let nodes = null; // { source, analyser } — disconnected on finish
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });

  function finish(played) {
    if (done) return;
    done = true;
    if (rafId) cancelAnimationFrame(rafId);
    // Disconnect this turn's graph. Each turn builds a fresh
    // source→analyser→destination chain on the one shared context; without
    // this they'd accumulate over a 30-45 min session.
    if (nodes) {
      try { nodes.source.disconnect(); nodes.analyser.disconnect(); } catch { /* already gone */ }
    }
    onAmplitude(0);
    resolveFinished({ played });
  }

  audio.onended = () => finish(true);
  audio.onerror = () => finish(false);

  const ctx = getAudioContext();
  if (ctx) {
    try {
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      nodes = { source, analyser };
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(bins);
        let sum = 0;
        for (let i = 0; i < bins.length; i++) sum += bins[i];
        onAmplitude(Math.min(1, sum / bins.length / 128)); // avg byte (0..255) → ~0..1
        rafId = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* createMediaElementSource throws if the element was already tapped or
         the context is unavailable; fall through to plain playback */
    }
  }

  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => finish(false));
  }

  return {
    finished,
    isPaused: () => audio.paused && !done,
    pause: () => { if (!done) audio.pause(); },
    resume: () => { if (!done) audio.play().catch(() => {}); },
  };
}
