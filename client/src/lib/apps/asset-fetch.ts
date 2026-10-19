import { readLimited } from "./limited-body";

export interface AssetRef {
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type AssetResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; reason: "origin" | "fetch" | "size" | "hash" };

/**
 * Fetches one of a manifest's `assets[]` from the apps origin and checks it
 * before the app ever sees a byte.
 *
 * - The URL must be on `appsOrigin` (a manifest is data, and must not make the
 *   page contact an address it chose) and a redirect is an error, so the bytes
 *   cannot come from anywhere else either.
 * - The body is read with the declared size as a hard limit, never buffered
 *   whole first; a body over it is `size`, and one under it is `size` too.
 * - Then the sha256 of the content must match.
 *
 * The browser's HTTP cache is used (`force-cache`): the path has the version in
 * it and the file is immutable.
 */
export async function fetchAsset(
  asset: AssetRef,
  appsOrigin: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<AssetResult> {
  try {
    if (new URL(asset.url).origin !== appsOrigin) return { ok: false, reason: "origin" };
  } catch {
    return { ok: false, reason: "origin" };
  }
  let body: Uint8Array | null;
  try {
    const response = await fetchImpl(asset.url, {
      cache: "force-cache",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return { ok: false, reason: "fetch" };
    body = await readLimited(response, asset.bytes);
  } catch {
    return { ok: false, reason: "fetch" };
  }
  if (!body || body.length !== asset.bytes) return { ok: false, reason: "size" };
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const digest = toHex(await crypto.subtle.digest("SHA-256", buffer));
  if (digest !== asset.sha256.toLowerCase()) return { ok: false, reason: "hash" };
  return { ok: true, bytes: buffer };
}
