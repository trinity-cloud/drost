export function mergeStreamText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  if (incoming === existing) {
    return existing;
  }
  if (incoming.startsWith(existing)) {
    return incoming;
  }
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) {
    return existing;
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap >= 4; overlap -= 1) {
    if (existing.slice(existing.length - overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }

  return existing + incoming;
}
