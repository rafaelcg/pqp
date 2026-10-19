import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateAppManifest } from "@pqp/shared";
import { unpackContainer } from "../src/container.ts";
import { packContainer } from "./container.mts";
import prepare, { CORES } from "../prepare.mts";
import { extract7z } from "./seven-zip.mts";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

function fixtureApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pqp-locadora-prepare-"));
  scratch.push(dir);
  return dir;
}

describe("the core container", () => {
  it("round-trips files through the browser's own inflate", async () => {
    const files = new Map<string, Uint8Array>([
      ["b.json", new TextEncoder().encode('{"a":1}')],
      ["a.wasm", Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)],
      ["empty.txt", new Uint8Array()],
    ]);
    const packed = packContainer(files);
    const out = await unpackContainer(packed);
    expect(Object.keys(out)).toEqual(["a.wasm", "b.json", "empty.txt"]);
    for (const [name, bytes] of files) expect(Buffer.from(out[name]!).equals(Buffer.from(bytes))).toBe(true);
  });

  it("is the same bytes every time, whatever order the files come in", () => {
    const a = new Map([["x.bin", new Uint8Array([1, 2, 3])], ["y.bin", new Uint8Array([4, 5, 6])]]);
    const b = new Map([["y.bin", new Uint8Array([4, 5, 6])], ["x.bin", new Uint8Array([1, 2, 3])]]);
    expect(Buffer.from(packContainer(a)).equals(Buffer.from(packContainer(b)))).toBe(true);
  });

  it("refuses what is not ours: bad magic, a truncated payload, a lying size, a path in a name", async () => {
    const good = packContainer(new Map([["a.bin", new Uint8Array([1, 2, 3, 4])]]));
    await expect(unpackContainer(Uint8Array.from([80, 75, 3, 4, 0, 0, 0, 0, 0]))).rejects.toThrow(/not a pqp core container/);
    await expect(unpackContainer(good.subarray(0, good.length - 1))).rejects.toThrow(/size does not match/);
    const lying = Uint8Array.from(good);
    // flip the declared size of the only entry: find "size":4 in the header
    const header = new TextDecoder().decode(lying.subarray(9, 9 + new DataView(lying.buffer).getUint32(5, true)));
    expect(header).toContain('"size":4');
    lying.set(new TextEncoder().encode('"size":5'), 9 + header.indexOf('"size":4'));
    await expect(unpackContainer(lying)).rejects.toThrow(/wrong size/);
    const pathy = packContainer(new Map([["../a.bin", new Uint8Array([1])]]));
    await expect(unpackContainer(pathy)).rejects.toThrow(/bad container entry/);
  });
});

describe("a real core, unpacked at build time", () => {
  const extractor = readFileSync(
    join(dirname(require.resolve("@emulatorjs/emulatorjs/package.json")), "data/compression/extract7z.js"),
    "utf8",
  );

  for (const core of CORES) {
    it(`${core.core}: the archive unpacks with the frontend's own decoder, and repacks to the same files`, async () => {
      const archive = new Uint8Array(
        readFileSync(join(dirname(require.resolve(`${core.pkg}/package.json`)), `${core.core}-legacy-wasm.data`)),
      );
      const files = await extract7z(extractor, archive);
      expect([...files.keys()]).toEqual(
        [`${core.core}_libretro.js`, `${core.core}_libretro.wasm`, "build.json", "core.json", "license.txt"].sort(),
      );
      expect(files.get(`${core.core}_libretro.wasm`)!.length).toBeGreaterThan(1_000_000);
      // WebAssembly magic
      expect([...files.get(`${core.core}_libretro.wasm`)!.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);

      const rest = new Map([...files].filter(([name]) => !name.endsWith(".js")));
      const out = await unpackContainer(packContainer(rest));
      for (const [name, bytes] of rest) expect(Buffer.from(out[name]!).equals(Buffer.from(bytes)), name).toBe(true);
    });
  }
});

describe("prepare: the generated half of the bundle", () => {
  it("writes the patched frontend, the glue with its integrity, the cores and the notices, the same every time", async () => {
    const dir = fixtureApp();
    await prepare({ appDir: dir });
    const first = Object.fromEntries(walk(join(dir, "public")).map((f) => [relative(dir, f), readFileSync(f)]));
    expect(Object.keys(first).sort()).toEqual([
      "public/core-js/fceumm.js",
      "public/core-js/mgba.js",
      "public/cores/fceumm-core.pqpc",
      "public/cores/fceumm.json",
      "public/cores/mgba-core.pqpc",
      "public/cores/mgba.json",
      "public/ejs/core-sri.js",
      "public/ejs/emulator.min.js",
      "public/notices.txt",
    ]);

    // the integrity table is the hash of the glue files that are served
    const sri = JSON.parse(/freeze\((.*)\);/.exec(first["public/ejs/core-sri.js"]!.toString())![1]!) as Record<string, string>;
    for (const core of ["fceumm", "mgba"]) {
      expect(sri[core]).toBe(`sha384-${createHash("sha384").update(first[`public/core-js/${core}.js`]!).digest("base64")}`);
    }

    // the notices name every component with its license and a source link, and no game
    const notices = first["public/notices.txt"]!.toString();
    for (const needle of ["EmulatorJS 4.2.3", "GPL-3.0-only", "GPL-2.0-or-later", "MPL-2.0", "github.com/EmulatorJS/EmulatorJS", "github.com/libretro/libretro-fceumm", "github.com/mgba-emu/mgba"]) {
      expect(notices, needle).toContain(needle);
    }

    await prepare({ appDir: dir });
    const second = Object.fromEntries(walk(join(dir, "public")).map((f) => [relative(dir, f), readFileSync(f)]));
    for (const key of Object.keys(first)) expect(second[key]!.equals(first[key]!), key).toBe(true);
  });
});

describe("what is in the app's folder", () => {
  const GAME_FILE = /\.(nes|gb|gbc|gba|sfc|smc|md|gen|bin|rom|zip|7z|rar)$/i;

  it("has no game file, no archive and nothing shaped like one (the cores are generated, never committed)", () => {
    const files = walk(here).filter((f) => !f.includes("/node_modules/") && !f.includes("/public/") && !f.includes("/test-results/"));
    expect(files.filter((f) => GAME_FILE.test(f))).toEqual([]);
  });

  it("builds an app whose manifest is valid", () => {
    const source = JSON.parse(readFileSync(join(here, "manifest.source.json"), "utf8")) as unknown;
    const result = validateAppManifest(source, { source: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
