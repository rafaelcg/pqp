import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { packContainer } from "./build/container.mts";
import { renderNotices, type NoticeComponent } from "./build/notices.mts";
import { patchFrontend, readFrontend } from "./build/patch.mts";
import { extract7z } from "./build/seven-zip.mts";

/**
 * Locadora's pre-build step, called by the packager (`tools/apps-build`)
 * before the Vite build. It writes the generated half of the bundle into
 * `apps/locadora/public/` (git-ignored; Vite copies it as it is):
 *
 *   ejs/emulator.min.js   the EmulatorJS frontend, four patches applied
 *   ejs/core-sri.js       the Subresource Integrity of each core's JS glue
 *   core-js/<core>.js     the cores' JS glue (code, so in the bundle under SRI)
 *   cores/<core>-core.pqpc  each core repacked for DecompressionStream
 *   cores/<core>.json     each core's report (EmulatorJS reads it before the core)
 *   notices.txt           the third-party notices
 *
 * `index.html` loads the first two as plain scripts (so the packager puts SRI
 * on them), `core-js/` is loaded by the patched frontend with the SRI of
 * `core-sri.js`, and the manifest declares the `.pqpc` and `.json` files as
 * `assets[]` (the host fetches them, checks their hash and hands them over).
 * The result depends only on the installed packages, which the lockfile pins.
 */

const require = createRequire(import.meta.url);

export interface PrepareContext {
  appDir: string;
}

/** The two cores that ship, with the license checked for each (docs/EMULATOR_ROOM.md). */
export const CORES = [
  {
    core: "fceumm",
    pkg: "@emulatorjs/core-fceumm",
    system: "NES",
    license: "GPL-2.0-or-later",
    source: "https://github.com/EmulatorJS/libretro-fceumm",
    upstream: "https://github.com/libretro/libretro-fceumm",
  },
  {
    core: "mgba",
    pkg: "@emulatorjs/core-mgba",
    system: "Game Boy, Game Boy Color and Game Boy Advance",
    license: "MPL-2.0",
    source: "https://github.com/EmulatorJS/mgba",
    upstream: "https://github.com/mgba-emu/mgba",
  },
] as const;

function packageDir(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

function version(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
}

/** Writes only when the bytes differ, so `apps:dev`'s file watcher does not see its own output. */
function put(root: string, path: string, data: Uint8Array | string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  if (existsSync(file) && readFileSync(file).equals(bytes)) return;
  writeFileSync(file, bytes);
}

export default async function prepare({ appDir }: PrepareContext): Promise<void> {
  const out = join(appDir, "public");
  const frontendDir = packageDir("@emulatorjs/emulatorjs");
  const extractor = readFileSync(join(frontendDir, "data", "compression", "extract7z.js"), "utf8");

  const sri: Record<string, string> = {};
  const notices: NoticeComponent[] = [
    {
      name: "EmulatorJS",
      version: version(frontendDir),
      role: "the emulator frontend (screen, sound, controls, settings)",
      license: "GPL-3.0-only",
      licenseText: readFileSync(join(frontendDir, "LICENSE"), "utf8"),
      source: "https://github.com/EmulatorJS/EmulatorJS",
      modification:
        "four build-time text edits (core unpacking, core script loading, style writes, update check) in apps/locadora/build/patch.mts of the pqp repository; the netplay client library is not shipped",
    },
  ];

  for (const entry of CORES) {
    const dir = packageDir(entry.pkg);
    const archive = new Uint8Array(readFileSync(join(dir, `${entry.core}-legacy-wasm.data`)));
    const files = await extract7z(extractor, archive);

    const glue = files.get(`${entry.core}_libretro.js`);
    if (!glue) throw new Error(`${entry.pkg}: the archive has no ${entry.core}_libretro.js`);
    put(out, `core-js/${entry.core}.js`, glue);
    sri[entry.core] = `sha384-${createHash("sha384").update(glue).digest("base64")}`;

    const rest = new Map([...files].filter(([name]) => name !== `${entry.core}_libretro.js`));
    for (const need of [`${entry.core}_libretro.wasm`, "core.json", "build.json"]) {
      if (!rest.has(need)) throw new Error(`${entry.pkg}: the archive has no ${need}`);
    }
    put(out, `cores/${entry.core}-core.pqpc`, packContainer(rest));
    put(out, `cores/${entry.core}.json`, readFileSync(join(dir, "reports", `${entry.core}.json`)));

    notices.push({
      name: `${entry.core === "fceumm" ? "FCEUmm" : "mGBA"} core`,
      version: version(dir),
      role: `the ${entry.system} emulator (WebAssembly)`,
      license: entry.license,
      licenseText: new TextDecoder().decode(rest.get("license.txt") ?? new Uint8Array()),
      source: entry.source,
      upstream: entry.upstream,
      modification: "none to the program; the files of the core archive are repacked into a deflate container (build/container.mts) and its JS glue is served as a separate file",
    });
  }

  put(out, "ejs/emulator.min.js", patchFrontend(readFrontend(frontendDir)));
  put(
    out,
    "ejs/core-sri.js",
    `window.PQP_CORE_JS_SRI = Object.freeze(${JSON.stringify(Object.fromEntries(Object.entries(sri).sort()))});\n`,
  );
  put(out, "notices.txt", renderNotices(notices, "https://github.com/rafaelcg/pqp"));
}
