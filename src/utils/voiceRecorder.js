// Thin wrapper around getUserMedia + MediaRecorder for push-to-talk capture.
// Kept stateless-ish (all state lives in the returned recorder instance) so
// InterviewScreen can just call start()/stop() and not think about the Web
// Audio plumbing.
export function createVoiceRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let stream = null;

  // Throws if the user denies mic permission (or no mic exists) — caller is
  // expected to catch this and fall back to the plain text input.
  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferredMime = "audio/webm;codecs=opus";
    const mimeType = typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(preferredMime)
      ? preferredMime
      : "";
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunks = [];
    mediaRecorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    mediaRecorder.start();
  }

  // Resolves with the recorded Blob once the recorder has fully stopped.
  function stop() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder) {
        reject(new Error("Recorder was never started."));
        return;
      }
      mediaRecorder.addEventListener(
        "stop",
        () => {
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
          stream.getTracks().forEach((track) => track.stop());
          resolve(blob);
        },
        { once: true }
      );
      mediaRecorder.stop();
    });
  }

  return { start, stop };
}
