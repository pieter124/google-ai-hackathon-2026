import { useEffect, useRef, h } from "../reactRuntime.js";
import { AVATAR_VIDEO_SRC } from "../config.js";

// Top-right interviewer avatar + caption. Two visual modes:
//   • if AVATAR_VIDEO_SRC is set, a muted looping video (talking-head render);
//   • otherwise an animated orb that pulses on the interviewer's voice.
//
// Amplitude arrives via a ref (not a prop) on purpose: the audio tap updates
// it at ~60fps, and driving that through React state would re-render the whole
// interview screen every frame. Instead this component runs one rAF loop that
// reads the ref and writes the orb's transform straight to the DOM.
export default function Avatar({ state, amplitudeRef, caption }) {
  const orbRef = useRef(null);

  useEffect(() => {
    let raf;
    const tick = () => {
      const orb = orbRef.current;
      if (orb) {
        const amp = amplitudeRef.current || 0;
        const scale = 1 + amp * 0.5; // 1.0 at rest → ~1.5 at full volume
        orb.style.transform = `scale(${scale})`;
        orb.style.opacity = String(0.55 + amp * 0.45);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [amplitudeRef]);

  const statusLabel = {
    idle: "",
    listening: "Listening…",
    processing: "Thinking…",
    speaking: "Speaking",
  }[state];

  return h(
    "div",
    { className: `avatar-dock avatar-${state}` },
    h(
      "div",
      { className: "avatar-visual" },
      AVATAR_VIDEO_SRC
        ? h("video", {
            className: "avatar-video",
            src: AVATAR_VIDEO_SRC,
            autoPlay: true,
            loop: true,
            muted: true,
            playsInline: true,
          })
        : h(
            "div",
            { className: "avatar-orb-wrap" },
            h("div", { className: "avatar-orb", ref: orbRef }),
            h("div", { className: "avatar-orb-core" })
          ),
      statusLabel && h("span", { className: "avatar-status" }, statusLabel)
    ),
    caption && h("div", { className: "avatar-caption" }, caption)
  );
}
