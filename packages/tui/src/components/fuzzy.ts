/** Simple fuzzy match: checks if all characters of `needle` appear in `haystack` in order. */
export function fuzzyMatch(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  let ni = 0
  for (let hi = 0; hi < h.length && ni < n.length; hi++) {
    if (h[hi] === n[ni]) ni++
  }
  return ni === n.length
}

/** Fuzzy match with a score — lower is better. Returns -1 if no match. */
export function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  if (n === "") return 0
  let ni = 0
  let score = 0
  let lastMatch = -1
  for (let hi = 0; hi < h.length && ni < n.length; hi++) {
    if (h[hi] === n[ni]) {
      if (lastMatch !== -1) score += hi - lastMatch
      else score += hi
      lastMatch = hi
      ni++
    }
  }
  return ni === n.length ? score : -1
}

/** Sort items by fuzzy score against a query string. */
export function fuzzySort<T>(
  query: string,
  items: readonly T[],
  getString: (item: T) => string,
): readonly T[] {
  if (query.trim() === "") return items
  const scored = items
    .map((item) => ({ item, score: fuzzyScore(query, getString(item)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.item)
  return scored
}
