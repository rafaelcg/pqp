import { createHash } from "node:crypto";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A Subresource Integrity value, `sha384-<base64>`. */
export function sriSha384(data: Uint8Array | string): string {
  return `sha384-${createHash("sha384").update(data).digest("base64")}`;
}

/** JSON with every object's keys sorted and no whitespace: one byte string per value, whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** What `catalog.json` calls `manifestSha256`: the sha256 of the built manifest's canonical JSON. */
export function manifestSha256(manifest: unknown): string {
  return sha256Hex(canonicalJson(manifest));
}
