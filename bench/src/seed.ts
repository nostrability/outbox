/**
 * Mulberry32: simple, fast, 32-bit seedable PRNG.
 * Returns values in [0, 1) like Math.random().
 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolveSeed(input: number | "random"): number {
  if (input === "random") {
    return Date.now();
  }
  return input;
}
