// Plain JS cumulative-weight picker — no API needed. Each item must expose a
// numeric `.weight`; higher weight = proportionally more likely to be picked.
export function pickWeighted(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1]; // floating-point fallback
}
