import { deflateSync } from "fflate";
import { CONTAINER_MAGIC } from "../src/container.ts";

/**
 * Writes the container `src/container.ts` reads. The deflate is `fflate`'s,
 * pure JavaScript: Node's own zlib is not guaranteed to produce the same bytes
 * from one release to the next, and these bytes are hashed into the manifest,
 * so a build on another Node must not change the catalog. Names are sorted.
 */
export function packContainer(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const names = [...files.keys()].sort();
  const payloads = names.map((name) => deflateSync(files.get(name)!, { level: 9, mem: 12 }));
  const header = new TextEncoder().encode(
    JSON.stringify(names.map((name, i) => ({ name, size: files.get(name)!.length, csize: payloads[i]!.length }))),
  );
  const out = new Uint8Array(CONTAINER_MAGIC.length + 4 + header.length + payloads.reduce((n, p) => n + p.length, 0));
  out.set(new TextEncoder().encode(CONTAINER_MAGIC), 0);
  new DataView(out.buffer).setUint32(CONTAINER_MAGIC.length, header.length, true);
  out.set(header, CONTAINER_MAGIC.length + 4);
  let offset = CONTAINER_MAGIC.length + 4 + header.length;
  for (const payload of payloads) {
    out.set(payload, offset);
    offset += payload.length;
  }
  return out;
}
