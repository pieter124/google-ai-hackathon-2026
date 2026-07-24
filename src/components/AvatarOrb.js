import { useEffect, useRef, h } from "../reactRuntime.js";

// The interviewer's animated face: their generated portrait inside a ring
// that pulses with the spoken reply's amplitude, with two extra generated
// frames layered on top — mouth-open (shown while the voice is actually
// loud, so the mouth flaps in time with speech) and eyes-closed (flashed
// briefly on a randomized blink timer, so they look alive even in silence).
// Amplitude comes from `getLevel` (utils/audio.js's offline envelope, keyed
// to playback position — NOT a live analyser, see the note there about echo
// cancellation). Frames fade via direct DOM opacity writes from a
// requestAnimationFrame loop — this moves at speech frequency and would be
// wasteful as React state.
//
// Mouth thresholds have hysteresis (open above OPEN, close below CLOSE) so
// the mouth doesn't strobe at the threshold boundary.
const MOUTH_OPEN_LEVEL = 0.07;
const MOUTH_CLOSE_LEVEL = 0.04;
const BLINK_MIN_GAP_MS = 2500;
const BLINK_MAX_GAP_MS = 5500;
const BLINK_DURATION_MS = 130;

export default function AvatarOrb({ getLevel, active, frames, videoSrc, initials }) {
  const ringRef = useRef(null);
  const talkingRef = useRef(null);
  const blinkRef = useRef(null);
  const videoRef = useRef(null);
  const rafRef = useRef(null);
  const mouthOpenRef = useRef(false);

  // Pre-generated Veo talking loop, when one exists: it fades in and plays
  // (muted) for as long as the interviewer is speaking, then freezes and
  // fades back to the still portrait. Takes precedence over the mouth-frame
  // flap, which stays as the fallback for characters without a clip.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active) {
      video.style.opacity = "1";
      video.play().catch(() => {}); // muted+playsInline, so this should never block
    } else {
      video.style.opacity = "0";
      video.pause();
    }
  }, [active, videoSrc]);

  // Ring pulse + mouth flap, both driven by the live amplitude.
  useEffect(() => {
    const setMouth = (open) => {
      mouthOpenRef.current = open;
      if (talkingRef.current) talkingRef.current.style.opacity = open ? "1" : "0";
    };
    if (!active || !getLevel) {
      if (ringRef.current) {
        ringRef.current.style.boxShadow = "none";
        ringRef.current.style.transform = "scale(1)";
      }
      setMouth(false);
      return;
    }
    const tick = () => {
      const level = Math.min(1, getLevel() * 2.5); // speech RMS ~0-0.35 → 0-1ish
      if (ringRef.current) {
        ringRef.current.style.transform = `scale(${(1 + level * 0.08).toFixed(3)})`;
        ringRef.current.style.boxShadow = `0 0 0 ${(level * 14).toFixed(1)}px rgba(91, 140, 255, 0.25)`;
      }
      if (!videoSrc && (mouthOpenRef.current ? level < MOUTH_CLOSE_LEVEL : level > MOUTH_OPEN_LEVEL)) {
        setMouth(!mouthOpenRef.current);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setMouth(false);
    };
  }, [getLevel, active, videoSrc]);

  // Blink scheduler — runs whenever a blink frame exists, speaking or not.
  useEffect(() => {
    if (!frames || !frames.blink) return;
    let blinkTimer = null;
    let openTimer = null;
    const schedule = () => {
      const gap = BLINK_MIN_GAP_MS + Math.random() * (BLINK_MAX_GAP_MS - BLINK_MIN_GAP_MS);
      blinkTimer = setTimeout(() => {
        // Skip the blink mid-word — eyes closed with the mouth open reads
        // as a glitch, not a blink.
        if (blinkRef.current && !mouthOpenRef.current) {
          blinkRef.current.style.opacity = "1";
          openTimer = setTimeout(() => {
            if (blinkRef.current) blinkRef.current.style.opacity = "0";
          }, BLINK_DURATION_MS);
        }
        schedule();
      }, gap);
    };
    schedule();
    return () => {
      clearTimeout(blinkTimer);
      clearTimeout(openTimer);
    };
  }, [frames && frames.blink]);

  const base = frames && frames.base;
  return h(
    "div",
    { className: `avatar-orb${active ? " avatar-orb-active" : ""}`, ref: ringRef },
    base
      ? h(
          "div",
          { className: "avatar-frames avatar-breathing" },
          h("img", { className: "avatar-orb-img", src: base, alt: "" }),
          frames.talking &&
            h("img", { className: "avatar-orb-img avatar-frame-overlay", src: frames.talking, alt: "", ref: talkingRef }),
          frames.blink &&
            h("img", { className: "avatar-orb-img avatar-frame-overlay", src: frames.blink, alt: "", ref: blinkRef }),
          videoSrc &&
            h("video", {
              className: "avatar-orb-video avatar-frame-overlay",
              src: videoSrc,
              muted: true,
              loop: true,
              playsInline: true,
              preload: "auto",
              ref: videoRef,
            })
        )
      : h("div", { className: "avatar-orb-img avatar-fallback" }, initials || "?")
  );
}
