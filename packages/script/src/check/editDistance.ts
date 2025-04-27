/** Levenshtein edit distance between two strings, using a two-row rolling array. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1, // deletion
        current[j - 1]! + 1, // insertion
        previous[j - 1]! + cost, // substitution
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/**
 * Finds the best "did you mean" suggestion for `target` among `candidates`, or `undefined` if
 * nothing is close enough. The threshold scales with word length so short names still get useful
 * suggestions without long names matching almost anything.
 */
export function didYouMean(target: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  const threshold = Math.max(1, Math.floor(target.length / 3) + 1);
  for (const candidate of candidates) {
    if (candidate === target) continue;
    const distance = editDistance(target, candidate);
    if (distance <= threshold && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
