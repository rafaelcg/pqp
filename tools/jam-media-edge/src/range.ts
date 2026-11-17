/**
 * `Range` for audio and video seeking. One `bytes=` range is honoured; several
 * ranges, a unit that is not `bytes`, or anything malformed is IGNORED and the
 * whole object is served as a 200, which RFC 9110 allows a server to do for
 * any Range it chooses not to honour. (A malformed header must not become a
 * 416: `<audio>` retries a 416 in a loop.)
 */

export type ByteRange =
  | { kind: "offset"; start: number; end: number | null }
  | { kind: "suffix"; length: number };

export function parseRange(header: string | null): ByteRange | null {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") {
    return null;
  }
  if (first === "") {
    const length = Number(last);
    return length > 0 ? { kind: "suffix", length } : null;
  }
  const start = Number(first);
  const end = last === "" ? null : Number(last);
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) {
    return null;
  }
  return { kind: "offset", start, end };
}

/** The inclusive byte window a range selects out of `size` bytes, or null when it cannot be satisfied (416). */
export function resolveRange(range: ByteRange, size: number): { start: number; end: number } | null {
  if (size <= 0) {
    return null;
  }
  if (range.kind === "suffix") {
    return { start: Math.max(0, size - range.length), end: size - 1 };
  }
  if (range.start >= size) {
    return null;
  }
  return { start: range.start, end: range.end === null ? size - 1 : Math.min(range.end, size - 1) };
}

/** What to hand R2's `get` so it reads only the window. */
export function toR2Range(range: ByteRange): R2Range {
  if (range.kind === "suffix") {
    return { suffix: range.length };
  }
  return range.end === null ? { offset: range.start } : { offset: range.start, length: range.end - range.start + 1 };
}
