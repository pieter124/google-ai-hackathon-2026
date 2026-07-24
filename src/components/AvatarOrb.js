import { useEffect, useRef, h } from "../reactRuntime.js";

// The interviewer's face in the panel header: their generated portrait (or
// an initials fallback) inside a ring that pulses with the spoken reply's
// live amplitude. Reads the AnalyserNode wired up in utils/audio.js
// (prepareAudioPlayback) via a requestAnimationFrame loop, mutating the DOM
// directly through a ref rather than calling setState every frame — this
// needs to move at 60fps, and re-rendering React for each frame would be
// wasteful for a purely visual effect that never needs to be reflected back
// into app state.
export default function AvatarOrb({ analyser, active, imageSrc, initials }) {
  const ringRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    if (!active || !analyser) {
      if (ringRef.current) {
        ringRef.current.style.boxShadow = "none";
        ringRef.current.style.transform = "scale(1)";
      }
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const level = sum / data.length / 255; // 0-1
      if (ringRef.current) {
        ringRef.current.style.transform = `scale(${(1 + level * 0.08).toFixed(3)})`;
        ringRef.current.style.boxShadow = `0 0 0 ${(level * 14).toFixed(1)}px rgba(91, 140, 255, 0.25)`;
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
    { className: `avatar-orb${active ? " avatar-orb-active" : ""}`, ref: ringRef },
    imageSrc
      ? h("img", { className: "avatar-orb-img", src: imageSrc, alt: "" })
      : h("div", { className: "avatar-orb-img avatar-fallback" }, initials || "?")
  );
}
