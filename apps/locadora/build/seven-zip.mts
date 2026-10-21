import vm from "node:vm";

/**
 * Unpacks a 7z archive at BUILD time with the very decoder EmulatorJS ships for
 * the browser (`data/compression/extract7z.js`, a WebAssembly build of 7-Zip),
 * so no system `7z` and no new dependency is needed and the result does not
 * depend on the machine that builds.
 *
 * That file is a Web Worker script: it listens on `onmessage` for the archive
 * bytes and answers with `postMessage({ t: 2, file, data })` for every file and
 * `{ t: 1 }` when it is done (`EJS_COMPRESSION.decompressFile` in the frontend
 * is the browser side of the same protocol). It runs here in a throwaway `vm`
 * context that looks enough like a worker for it to start. The archive is a
 * file from an npm package the repository already depends on, the same trust
 * as any other build input.
 */
export async function extract7z(
  extractorSource: string,
  archive: Uint8Array,
  timeoutMs = 60_000,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const sandbox: Record<string, unknown> = {
    console: { log() {}, warn() {}, error() {} },
    WebAssembly,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    performance,
    setTimeout,
    clearTimeout,
    // the three things that make it believe it is inside a worker
    importScripts() {},
    location: { href: "http://localhost/extract7z.js" },
    close() {},
    postMessage(message: { t: number; file?: string; data?: Uint8Array }) {
      if (message.t === 2 && typeof message.file === "string" && message.data) {
        // copy: the array belongs to the extractor's heap
        files.set(message.file, new Uint8Array(message.data));
      } else if (message.t === 1) {
        finish();
      }
    },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractorSource, sandbox, { filename: "extract7z.js" });
  const onmessage = sandbox.onmessage;
  if (typeof onmessage !== "function") throw new Error("extract7z.js did not install an onmessage handler");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`7z extraction did not finish in ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    onmessage({ data: archive });
    await Promise.race([finished, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (files.size === 0) throw new Error("the 7z archive held no files");
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
