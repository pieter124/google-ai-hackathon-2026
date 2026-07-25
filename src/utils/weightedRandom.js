// Cumulative-weight picker. Each item needs a numeric `.weight`; higher weight
// is proportionally more likely.
export function pickWeighted(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1]; // floating-point fallback
}
