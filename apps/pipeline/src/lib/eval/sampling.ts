/**
 * Stratified sampling for eval-set-create, with a recorded seed so a sample is reproducible. A
 * uniform sample under-represents exactly the cells where models differ.
 */

/** A tiny, dependency-free deterministic PRNG (mulberry32) — good enough for sampling, not for
 * anything cryptographic. Two calls with the same seed produce the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates shuffle using an injected RNG — deterministic given the same `rand`. */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface StratifiedSampleOptions<T> {
  size: number;
  /** Combined strata key for one item, e.g. `${type}:${difficulty}`. */
  keyFn: (item: T) => string;
  /** Recorded and reused for reproducibility. Defaults to a fresh random seed when omitted, which
   * the caller should read back off the result and persist (`eval_sets.selection.seed`). */
  seed?: number;
}

export interface StratifiedSampleResult<T> {
  items: T[];
  seed: number;
  /** How many items were drawn from each stratum, keyed the same way `keyFn` produced them. */
  strataCounts: Record<string, number>;
}

/**
 * Draws `size` items from `items`, allocated proportionally across the strata `keyFn` assigns
 * them to (largest-remainder method, so allocations sum to exactly `size`), then shuffles each
 * stratum with a seeded RNG before taking its allocation. A stratum smaller than its proportional
 * allocation contributes all of its items — the shortfall isn't redistributed to other strata.
 */
export function stratifiedSample<T>(items: T[], opts: StratifiedSampleOptions<T>): StratifiedSampleResult<T> {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rand = mulberry32(seed);

  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = opts.keyFn(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const strataKeys = [...groups.keys()].sort();
  const total = items.length;
  const size = Math.min(opts.size, total);

  // Largest-remainder method: give each stratum floor(exact share), then distribute the
  // remaining seats to the strata with the largest fractional remainder, breaking ties by
  // strataKeys' sorted order so the allocation is deterministic for a given input.
  const exactShares = strataKeys.map((key) => (groups.get(key)!.length / total) * size);
  const allocations = new Map<string, number>();
  let allocated = 0;
  strataKeys.forEach((key, i) => {
    const floor = Math.floor(exactShares[i]);
    allocations.set(key, floor);
    allocated += floor;
  });
  const remainders = strataKeys
    .map((key, i) => ({ key, remainder: exactShares[i] - Math.floor(exactShares[i]) }))
    .sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key));
  for (let i = 0; allocated < size && i < remainders.length; i++, allocated++) {
    allocations.set(remainders[i].key, allocations.get(remainders[i].key)! + 1);
  }

  const sampledItems: T[] = [];
  const strataCounts: Record<string, number> = {};
  for (const key of strataKeys) {
    const group = groups.get(key)!;
    const want = Math.min(allocations.get(key) ?? 0, group.length);
    const shuffled = shuffle(group, rand);
    sampledItems.push(...shuffled.slice(0, want));
    strataCounts[key] = want;
  }

  return { items: sampledItems, seed, strataCounts };
}
