import { useEffect, useRef, h } from "../reactRuntime.js";

// Pulses on the interviewer's spoken-reply audio amplitude. Reads the
// AnalyserNode wired up in utils/audio.js (preparePcmAudio) via a
// requestAnimationFrame loop, mutating the DOM directly through a ref rather
// than calling setState every frame — this needs to move at 60fps, and
// re-rendering React for each frame would be wasteful for a purely visual
// effect that never needs to be reflected back into app state.
export default function AvatarOrb({ analyser, active }) {
  const coreRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!active || !analyser) {
      if (coreRef.current) {
        coreRef.current.style.transform = "scale(1)";
        coreRef.current.style.opacity = "0.7";
      }
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length; // 0-255
      const level = avg / 255;
      if (coreRef.current) {
        coreRef.current.style.transform = `scale(${(1 + level * 0.6).toFixed(3)})`;
        coreRef.current.style.opacity = (0.7 + level * 0.3).toFixed(3);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [analyser, active]);

  return h(
    "div",
    { className: `avatar-orb${active ? " avatar-orb-active" : ""}` },
    h("div", { className: "avatar-orb-core", ref: coreRef })
  );
}
