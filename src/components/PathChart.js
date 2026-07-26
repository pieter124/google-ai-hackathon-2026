import { h } from "../reactRuntime.js";

// The candidate's "path": progress (-1..+1) plotted over session time, from the
// per-turn and checkpoint signals in the session log. Answers "did they climb
// steadily toward a good solution, thrash, or drift the wrong way?". Hand-rolled
// SVG — the only allowed deps are React and CodeMirror, and a sparkline doesn't
// justify a charting library anyway.
//
// Geometry: x = time (first→last point across the width), y = progress with
// +1 at the top and -1 at the bottom, zero-line through the middle.
export default function PathChart({ series }) {
  const W = 520;
  const H = 140;
  const pad = 12;
  const midY = H / 2;

  if (!series || series.length === 0) {
    return h("p", { className: "muted" }, "No trajectory captured (too short a session).");
  }

  const tMax = Math.max(...series.map((p) => p.t), 1);
  const x = (t) => pad + (t / tMax) * (W - 2 * pad);
  const y = (p) => midY - p * (H / 2 - pad); // +1 → top, -1 → bottom

  // A single point can't form a line; draw it as a dot on the zero-relative y.
  const pts = series.map((p) => `${x(p.t).toFixed(1)},${y(p.progress).toFixed(1)}`);
  const linePath = "M" + pts.join(" L");
  const last = series[series.length - 1];
  const endUp = last.progress >= 0;

  return h(
    "svg",
    { className: "path-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Progress trajectory" },
    // zero baseline
    h("line", { x1: pad, y1: midY, x2: W - pad, y2: midY, className: "path-axis" }),
    h("text", { x: pad, y: pad, className: "path-tick" }, "toward solution"),
    h("text", { x: pad, y: H - 2, className: "path-tick" }, "wrong direction"),
    series.length > 1 &&
      h("path", { d: linePath, className: `path-line ${endUp ? "up" : "down"}`, fill: "none" }),
    // points
    series.map((p, i) =>
      h("circle", {
        key: i,
        cx: x(p.t),
        cy: y(p.progress),
        r: i === series.length - 1 ? 5 : 3,
        className: `path-dot ${p.progress >= 0 ? "up" : "down"}`,
      })
    )
  );
}
