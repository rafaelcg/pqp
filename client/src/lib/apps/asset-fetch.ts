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
  | { ok: false; reason: "fetch" | "size" | "hash" };

/**
 * Fetches one of a manifest's `assets[]` from the apps origin and checks it
 * before the app ever sees a byte: the size the manifest declared and the
 * sha256 of the content. The browser's HTTP cache is used (`force-cache`): the
 * path has the version in it and the file is immutable.
 */
export async function fetchAsset(
  asset: AssetRef,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<AssetResult> {
  let buffer: ArrayBuffer;
  try {
    const response = await fetchImpl(asset.url, {
      cache: "force-cache",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return { ok: false, reason: "fetch" };
    buffer = await response.arrayBuffer();
  } catch {
    return { ok: false, reason: "fetch" };
  }
  if (buffer.byteLength !== asset.bytes) return { ok: false, reason: "size" };
  const digest = toHex(await crypto.subtle.digest("SHA-256", buffer));
  if (digest !== asset.sha256.toLowerCase()) return { ok: false, reason: "hash" };
  return { ok: true, bytes: buffer };
}
