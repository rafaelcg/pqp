/**
 * Reading a response while it arrives, and the arithmetic of "12 of 54 MB".
 *
 * Opt-in on purpose: `JamPlayer.decode` reads the whole body with
 * `arrayBuffer()` unless a caller asks for progress, so the studio and the
 * in-app player take exactly the path they always did. Only the public site
 * asks (`jam-site/player.ts`).
 */

import { JAM_AUDIO_MAX_BYTES } from "@pqp/shared";

/** Bytes received so far and the size the server announced, or null when it did not say. */
export type FetchProgress = (loaded: number, total: number | null) => void;

/**
 * The size to trust from a response. `Content-Length` counts the ENCODED body,
 * and `res.body` hands over the DECODED one, so with a `Content-Encoding` the
 * two are not the same unit and the number would be a lie that runs past 100%.
 */
export function announcedBytes(headers: Pick<Headers, "get">): number | null {
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    return null;
  }
  const raw = headers.get("content-length");
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read `res` to the end, reporting each chunk, and return the bytes. Without a
 * readable stream (an old engine, a mocked response) it falls back to
 * `arrayBuffer()` and reports the end only.
 *
 * The header is a hint, never a licence to allocate: a stem is an audio object,
 * which the server caps at `JAM_AUDIO_MAX_BYTES`, so a `Content-Length` above
 * that ceiling is refused before a byte is read, and a body that runs past it
 * (whatever the header said) is cancelled and refused. `maxBytes` is a
 * parameter for tests only.
 */
export async function readWithProgress(
  res: Response,
  onProgress: FetchProgress,
  maxBytes: number = JAM_AUDIO_MAX_BYTES,
): Promise<ArrayBuffer> {
  const total = announcedBytes(res.headers);
  const reader = res.body?.getReader();
  if (total !== null && total > maxBytes) {
    await reader?.cancel().catch(() => undefined);
    throw new Error("jam: stem larger than allowed");
  }
  if (!reader) {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error("jam: stem larger than allowed");
    onProgress(bytes.byteLength, total === null ? bytes.byteLength : total);
    return bytes;
  }
  // One buffer, written as the chunks arrive: sized by the announced length (at most the ceiling) or 1 MiB when
  // there is none, and doubled (never past the ceiling) if the body runs past it, so a finished stem is never
  // held twice (chunks AND a flattened copy).
  let buffer = new Uint8Array(Math.min(total ?? 1_048_576, maxBytes));
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (loaded + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("jam: stem larger than allowed");
    }
    if (loaded + value.byteLength > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(buffer.byteLength * 2, loaded + value.byteLength)));
      grown.set(buffer.subarray(0, loaded));
      buffer = grown;
    }
    buffer.set(value, loaded);
    loaded += value.byteLength;
    onProgress(loaded, total !== null && loaded > total ? null : total);
  }
  // The stream ended: what arrived is the whole of it, whatever the header said.
  onProgress(loaded, loaded);
  // Exactly sized in the usual case (the header was right), so no copy; a trimmed copy otherwise.
  return loaded === buffer.byteLength ? (buffer.buffer as ArrayBuffer) : buffer.slice(0, loaded).buffer;
}

export interface StemBytes {
  loaded: number;
  /** null until the response said how long it is. */
  total: number | null;
}

export interface SongBytes {
  loaded: number;
  total: number;
  /** false while some stem's size is a guess (a stem that has not started yet, or a server that did not say). */
  exact: boolean;
}

/**
 * Add the stems up. `stems` is what has reported so far; `count` is how many the
 * song has. A stem that has not reported a size is guessed at the mean of those
 * that did (the stems of a song are alike in length), so the total does not sit
 * at "the first four" and jump when the fifth starts; `exact` says whether any
 * guess was made. Null when nothing is known yet.
 */
export function songBytes(stems: readonly StemBytes[], count: number): SongBytes | null {
  if (count <= 0 || stems.length === 0) {
    return null;
  }
  let loaded = 0;
  let known = 0;
  let knownTotal = 0;
  for (const stem of stems) {
    loaded += stem.loaded;
    if (stem.total !== null) {
      known += 1;
      knownTotal += Math.max(stem.total, stem.loaded);
    }
  }
  if (known === 0) {
    return { loaded, total: 0, exact: false };
  }
  const guessed = Math.max(0, count - known);
  const mean = knownTotal / known;
  const total = Math.round(knownTotal + guessed * mean);
  return { loaded, total: Math.max(total, loaded), exact: guessed === 0 };
}

/** 0 to 1, never 1 until the end is real; null when there is no total to measure against. */
export function songFraction(bytes: SongBytes | null): number | null {
  if (!bytes || bytes.total <= 0) {
    return null;
  }
  return Math.min(1, bytes.loaded / bytes.total);
}

/** Megabytes the way a person reads them: one decimal under 10, whole above, in the reader's own separator. */
export function megabytes(bytes: number, locale?: string): string {
  const mb = bytes / 1_000_000;
  try {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: mb < 10 ? 1 : 0,
      minimumFractionDigits: mb < 10 ? 1 : 0,
    }).format(mb);
  } catch {
    return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
  }
}
