import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The emulator room's static files, taken from npm and served from OUR origin.
 *
 * Node only (imported by `vite.config.ts` and by tests), never by the bundle.
 *
 * Nothing is fetched from a CDN, at build or at run time: the EmulatorJS
 * frontend (`@emulatorjs/emulatorjs`, GPL-3.0) and the two cores below come
 * from the package manager, and the page that runs them (`public/emulator/
 * frame.html`) carries a policy that forbids it from talking to anywhere else.
 *
 * ONLY THE CORES NAMED HERE ARE EVER SHIPPED. `@emulatorjs/cores` (every core)
 * is deliberately not installed (`ignoredOptionalDependencies` in
 * `pnpm-workspace.yaml`), because several of those are licensed
 * non-commercial-only, which AGPL-3.0 cannot carry. See `docs/EMULATOR_ROOM.md`
 * for each core's license and for the ones that were refused.
 */

/** Where the files are served, relative to the site root. */
export const EMULATOR_ASSET_PREFIX = "/emulator/ejs/";

/** A core this build ships, with the license that was checked for it. */
export interface ShippedCore {
  /** The EmulatorJS core name, which is also the npm package suffix. */
  core: string;
  /** The npm package that carries it. */
  pkg: string;
  /** SPDX-style license of the core as shipped (see docs/EMULATOR_ROOM.md). */
  license: string;
}

export const SHIPPED_CORES: readonly ShippedCore[] = [
  { core: "fceumm", pkg: "@emulatorjs/core-fceumm", license: "GPL-2.0-or-later" },
  { core: "mgba", pkg: "@emulatorjs/core-mgba", license: "MPL-2.0" },
];

/**
 * The frontend's own scripts, in the order its `loader.js` loads them, MINUS
 * `socket.io.min.js`: that is the client library of its netplay feature, and
 * netplay is out of scope (and refused by `docs/EMULATOR_ROOM.md`). Leaving the
 * library out means the code path cannot run even if a flag were set by mistake.
 */
const FRONTEND_SCRIPTS = [
  "emulator.js",
  "nipplejs.js",
  "shaders.js",
  "storage.js",
  "gamepad.js",
  "GameManager.js",
  "compression.js",
] as const;

/** Frontend languages we have copy for (the rest stay English). */
const FRONTEND_LANGUAGES = ["es-ES", "pt-BR"] as const;

export type EmulatorAsset =
  | { kind: "file"; from: string; type: string }
  | { kind: "text"; text: string; type: string };

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
};

function typeOf(file: string): string {
  return TYPES[path.extname(file)] ?? "application/octet-stream";
}

function packageDir(pkg: string): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve(`${pkg}/package.json`));
}

/**
 * Every file the emulator needs, keyed by its public path under
 * {@link EMULATOR_ASSET_PREFIX}.
 *
 * `emulator.min.js` is the frontend's scripts joined in the order its loader
 * would load them, which is what a published release ships and the npm package
 * leaves out. Without it the loader logs a scary error for each file before
 * falling back to the very same scripts.
 */
export function emulatorAssets(): Map<string, EmulatorAsset> {
  const out = new Map<string, EmulatorAsset>();
  const frontend = packageDir("@emulatorjs/emulatorjs");
  const data = path.join(frontend, "data");

  const file = (key: string, from: string) =>
    out.set(key, { kind: "file", from, type: typeOf(key) });

  file("loader.js", path.join(data, "loader.js"));
  file("emulator.min.css", path.join(data, "emulator.css"));
  out.set("emulator.min.js", {
    kind: "text",
    type: typeOf("x.js"),
    text: FRONTEND_SCRIPTS.map((name) =>
      fs.readFileSync(path.join(data, "src", name), "utf8"),
    ).join(";\n"),
  });
  for (const name of fs.readdirSync(path.join(data, "compression"))) {
    if (/\.(js|wasm)$/.test(name)) {
      file(`compression/${name}`, path.join(data, "compression", name));
    }
  }
  for (const lang of FRONTEND_LANGUAGES) {
    file(`localization/${lang}.json`, path.join(data, "localization", `${lang}.json`));
  }

  for (const { core, pkg } of SHIPPED_CORES) {
    const dir = packageDir(pkg);
    // The plain and the `-legacy` build: which one the frontend asks for
    // depends on the browser's WebGL. The `-thread` builds need
    // SharedArrayBuffer, which this site is not cross-origin isolated for.
    for (const variant of [`${core}-wasm.data`, `${core}-legacy-wasm.data`]) {
      file(`cores/${variant}`, path.join(dir, variant));
    }
    file(`cores/reports/${core}.json`, path.join(dir, "reports", `${core}.json`));
  }
  return out;
}

export function emulatorAssetBytes(asset: EmulatorAsset): Buffer | string {
  return asset.kind === "text" ? asset.text : fs.readFileSync(asset.from);
}
