/**
 * The container a core is shipped in. The EmulatorJS cores come as 7z
 * archives, which the frontend unpacks in a blob Web Worker that evals, and
 * the frame's policy allows neither. So the build (`build/container.mts`)
 * repacks each core into this trivial layout and the frame unpacks it with the
 * browser's own `DecompressionStream`:
 *
 *   "PQPC1" | u32 LE header length | JSON [{ name, size, csize }] | payloads
 *
 * one raw-deflate payload per file, in header order. The JS glue of a core is
 * not in the container: it is code, so it lives in the bundle under
 * Subresource Integrity (see `build/patch.mts`, the `corejs` patch).
 *
 * This file is the reader and runs in the frame (and in Node, for the tests).
 */

export const CONTAINER_MAGIC = "PQPC1";

/** What a core can hold. A container that claims more than this is not ours. */
export const MAX_ENTRIES = 16;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

interface Entry {
  name: string;
  size: number;
  csize: number;
}

export function isContainer(data: Uint8Array): boolean {
  if (data.length < CONTAINER_MAGIC.length + 4) return false;
  for (let i = 0; i < CONTAINER_MAGIC.length; i += 1) {
    if (data[i] !== CONTAINER_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function readHeader(data: Uint8Array): { entries: Entry[]; payloadStart: number } {
  if (!isContainer(data)) throw new Error("not a pqp core container");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(CONTAINER_MAGIC.length, true);
  const payloadStart = CONTAINER_MAGIC.length + 4 + headerLength;
  if (headerLength === 0 || payloadStart > data.length) throw new Error("bad container header length");
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(data.subarray(CONTAINER_MAGIC.length + 4, payloadStart)),
  );
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_ENTRIES) {
    throw new Error("bad container entry list");
  }
  const entries: Entry[] = [];
  let offset = payloadStart;
  for (const raw of parsed as Array<Record<string, unknown>>) {
    const { name, size, csize } = raw;
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(name) ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(csize) ||
      (size as number) < 0 ||
      (size as number) > MAX_FILE_BYTES ||
      (csize as number) < 0
    ) {
      throw new Error("bad container entry");
    }
    entries.push({ name, size: size as number, csize: csize as number });
    offset += csize as number;
  }
  if (offset !== data.length) throw new Error("container size does not match its header");
  return { entries, payloadStart };
}

async function inflate(payload: Uint8Array, size: number): Promise<Uint8Array> {
  const stream = new Blob([payload as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length !== size) throw new Error("a container file inflated to the wrong size");
  return out;
}

/** Every file of the container, by name. Rejects on anything malformed. */
export async function unpackContainer(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  const { entries, payloadStart } = readHeader(data);
  const files: Record<string, Uint8Array> = {};
  let offset = payloadStart;
  for (const entry of entries) {
    files[entry.name] = await inflate(data.subarray(offset, offset + entry.csize), entry.size);
    offset += entry.csize;
  }
  return files;
}
