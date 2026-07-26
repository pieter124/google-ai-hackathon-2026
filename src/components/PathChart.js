import { h } from "../reactRuntime.js";

// The candidate's path through the session: Agent 1's and Agent 2's -1..+1
// trajectory reads, plotted against time. It answers the question the path
// narrative can only assert — did they climb steadily, thrash in the middle,
// or drift the wrong way? Hand-rolled SVG on purpose: React and CodeMirror
// are the only dependencies this app has, and a sparkline is no reason to add
// a third.
//
// x is time from the first signal to the last; y puts +1 at the top and -1 at
// the bottom with the zero line through the middle.
const WIDTH = 520;
const HEIGHT = 140;
const PAD = 14;

export default function PathChart({ series }) {
  if (!series || series.length === 0) {
    return h("p", { className: "muted" }, "No trajectory was captured — the session was too short.");
  }

  const midY = HEIGHT / 2;
  const tMax = Math.max(...series.map((p) => p.t), 1);
  const xOf = (t) => PAD + (t / tMax) * (WIDTH - 2 * PAD);
  const yOf = (progress) => midY - progress * (midY - PAD);

  const points = series.map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.progress).toFixed(1)}`);
  const endedWell = series[series.length - 1].progress >= 0;

  return h(
    "svg",
    {
      className: "path-chart",
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: "img",
      "aria-label": `Progress trajectory across ${series.length} points, ending ${endedWell ? "positive" : "negative"}`,
    },
    h("line", { className: "path-axis", x1: PAD, y1: midY, x2: WIDTH - PAD, y2: midY }),
    h("text", { className: "path-tick", x: PAD, y: PAD - 2 }, "toward the solution"),
    h("text", { className: "path-tick", x: PAD, y: HEIGHT - 4 }, "wrong direction"),
    series.length > 1 &&
      h("path", { className: `path-line ${endedWell ? "up" : "down"}`, d: `M${points.join(" L")}`, fill: "none" }),
    series.map((p, i) =>
      h("circle", {
        key: i,
        className: `path-dot ${p.progress >= 0 ? "up" : "down"}`,
        cx: xOf(p.t),
        cy: yOf(p.progress),
        r: i === series.length - 1 ? 5 : 3,
      })
    )
  );
}
