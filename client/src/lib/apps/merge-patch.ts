import { jsonByteLength, type JsonValue } from "@pqp/shared";

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RFC 7396 JSON Merge Patch. A non-object patch replaces the target; an object
 * patch merges key by key, and a `null` value deletes the key. The result is
 * built on prototype-less objects, so a key named `__proto__` is an ordinary
 * key and never reaches a prototype.
 */
export function applyMergePatch(target: JsonValue | undefined, patch: JsonValue): JsonValue {
  if (!isObject(patch)) return patch;
  const out: { [key: string]: JsonValue } = Object.create(null);
  if (isObject(target)) {
    for (const key of Object.keys(target)) out[key] = target[key] as JsonValue;
  }
  for (const key of Object.keys(patch)) {
    const value = patch[key] as JsonValue;
    if (value === null) delete out[key];
    else out[key] = applyMergePatch(out[key], value);
  }
  return out;
}

/** What the session state would weigh, in compact UTF-8 bytes, after `patch`. */
export function stateBytesAfter(current: JsonValue, patch: JsonValue): number {
  return jsonByteLength(applyMergePatch(current, patch));
}
