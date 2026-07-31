// Pure vector math for the semantic features — no model, no DOM.

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Indices of `items`, most-similar-to-`query` first.
export function rankBySimilarity(query: Float32Array, items: Float32Array[]): number[] {
  return items
    .map((vec, i) => ({ i, s: cosine(query, vec) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}

// Greedy max-min (farthest-point) selection: start from a random seed, then
// repeatedly take the item farthest from everything already chosen. Spreads
// the picks across the embedding space — the "varied eight".
export function diversePick(
  items: Float32Array[],
  n: number,
  rand: () => number = Math.random
): number[] {
  if (items.length <= n) return items.map((_, i) => i);
  const picked = [Math.floor(rand() * items.length)];
  const minDist = items.map((vec) => 1 - cosine(vec, items[picked[0]]));
  while (picked.length < n) {
    let best = -1, bestDist = -Infinity;
    for (let i = 0; i < items.length; i++) {
      if (minDist[i] > bestDist && !picked.includes(i)) {
        best = i;
        bestDist = minDist[i];
      }
    }
    picked.push(best);
    for (let i = 0; i < items.length; i++) {
      minDist[i] = Math.min(minDist[i], 1 - cosine(items[i], items[best]));
    }
  }
  return picked;
}
