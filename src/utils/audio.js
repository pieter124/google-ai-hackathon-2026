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

// Plays a base64 MP3 payload (from Cloud Text-to-Speech). Never rejects:
// browsers may block autoplay outside a user gesture, and we don't want that
// to strand the UI — the interviewer's line is always shown as text too, so
// audio is a bonus, not a requirement. Resolves { played: bool }.
export function playBase64Audio(base64Mp3) {
  return new Promise((resolve) => {
    try {
      const audio = new Audio(`data:audio/mp3;base64,${base64Mp3}`);
      audio.onended = () => resolve({ played: true, audio });
      audio.onerror = () => resolve({ played: false, audio });
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => resolve({ played: false, audio }));
      }
    } catch (err) {
      resolve({ played: false, audio: null });
    }
  });
}
