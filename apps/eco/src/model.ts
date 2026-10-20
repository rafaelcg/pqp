import type { JsonValue } from "@pqp/shared";

/** The shared counter lives in the session state as `{ count: n }`. */
export function readCount(value: JsonValue): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  const count = value.count;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/** The merge patch that moves the counter one up from `current`. */
export function incrementPatch(current: number): JsonValue {
  return { count: current + 1 };
}

/** The first grapheme-ish character of a name, for the avatar fallback. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}
