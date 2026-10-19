/**
 * Lets go of a body nobody will read: a response refused on its status, type or
 * final URL must not keep its stream (and the connection under it) open.
 */
export function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // a body already locked or used is already on its way out
  }
}

/** A body that sent nothing for longer than the caller's `idleMs`. */
export class BodyStalledError extends Error {
  constructor() {
    super("response body stalled");
    this.name = "BodyStalledError";
  }
}

export interface ReadLimitedOptions {
  /**
   * Longest wait for the next chunk. Past it the stream is cancelled and the
   * read rejects with `BodyStalledError`, so a body that stops half way cannot
   * leave the caller waiting forever. A slow body that keeps moving is fine.
   */
  idleMs?: number;
}

/**
 * Reads a response body with a hard byte limit. A declared `Content-Length`
 * over the limit is refused before a byte is read, and a body without one (or
 * lying about it) is read as a stream and abandoned the moment it passes the
 * limit, so a hostile or mis-served URL costs at most `maxBytes` of memory and
 * about that much bandwidth. Resolves to `null` when the body is over the limit.
 */
export async function readLimited(
  response: Response,
  maxBytes: number,
  options: ReadLimitedOptions = {},
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    discardBody(response);
    return null;
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.length > maxBytes ? null : whole;
  }
  const reader = response.body.getReader();
  const { idleMs } = options;
  const next = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (idleMs === undefined) return reader.read();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new BodyStalledError());
      }, idleMs);
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await next();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
