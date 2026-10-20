import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { packContainer } from "./build/container.mts";
import { fontNotices, renderNotices, type NoticeComponent } from "./build/notices.mts";
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

/**
 * The three cores that ship, with the license checked for each (docs/EMULATOR_ROOM.md).
 *
 * bsnes is not on npm, and EmulatorJS's own build of it (the nightly) aborts on a state save, a state load
 * and a reset: libco's emscripten backend lacks `co_derive` and `co_serializable`, and RetroArch's
 * `save_state_info` returns a dangling pointer and serialises where the fibers cannot switch. So it is built from source with both fixed
 * (`vendor/emulatorjs-core-bsnes/source/`: the two patches and the script that built it) and the
 * archive is vendored in `vendor/emulatorjs-core-bsnes/`, a local package with the same shape as an
 * `@emulatorjs/core-*` one, whose `package.json` pins the sha256 of every file it carries. Two things differ
 * from the npm cores:
 *  - `extraLicenses`: the archive's `license.txt` is bsnes's two-paragraph notice, so the full texts of
 *    every license in the linked code are appended from the vendored `licenses/` folder;
 *  - `retroarch`: the EmulatorJS RetroArch it is linked with gets its own notice (it is in every core, this
 *    is the one whose exact commit is known).
 */
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
  {
    core: "bsnes",
    pkg: "@pqp-vendor/emulatorjs-core-bsnes",
    system: "SNES",
    // bsnes GPL-3.0-or-later; libco and nall ISC; SameBoy (the Super Game Boy) MIT; blargg's snes_spc DSP
    // and snes_ntsc filter LGPL-2.1-or-later; lzma SDK and the S-DD1 decompressor public domain
    license: "GPL-3.0-or-later AND ISC AND MIT AND LGPL-2.1-or-later",
    source: "https://github.com/EmulatorJS/bsnes-libretro/tree/4b344745e3878e7c0675a60c624582935524b8f7",
    upstream: "https://github.com/libretro/bsnes-libretro",
    extraLicenses: ["GPL-3.0.txt", "libco-ISC.txt", "SameBoy-MIT.txt", "LGPL-2.1.txt"],
    modification:
      "built from that source by apps/locadora/vendor/emulatorjs-core-bsnes/source/build.sh with two patches: source/libco-emscripten-fiber.patch (adds co_derive and co_serializable to libco's emscripten backend, without which a state save, a state load and a reset abort) and source/retroarch-save-state-info.patch (RetroArch's save_state_info returned a local array by address, and serialised inside the JavaScript call where bsnes's fibers cannot switch; the main loop now makes the state on its next tick); the files of the core archive are repacked into a deflate container (build/container.mts) and its JS glue is served as a separate file",
    retroarch: "d907a125ee76e02a21d89003c140fd0b72886e90",
  },
] as const;

/** The name each core goes by in the notices. */
const CORE_TITLES: Readonly<Record<(typeof CORES)[number]["core"], string>> = {
  fceumm: "FCEUmm",
  mgba: "mGBA",
  bsnes: "bsnes",
};

interface VendoredPackage {
  pqpProvenance?: { files: Record<string, { sha256: string }> };
}

/** A vendored package pins the sha256 of every file it carries; a byte that moved fails the build. */
function checkVendored(dir: string, pkg: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as VendoredPackage;
  const pinned = manifest.pqpProvenance?.files;
  if (!pinned) return;
  for (const [file, { sha256 }] of Object.entries(pinned)) {
    const actual = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    if (actual !== sha256) throw new Error(`${pkg}: ${file} is sha256 ${actual}, pinned ${sha256}`);
  }
}

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
    checkVendored(dir, entry.pkg);
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
      name: `${CORE_TITLES[entry.core]} core`,
      version: version(dir),
      role: `the ${entry.system} emulator (WebAssembly)`,
      license: entry.license,
      licenseText: [
        new TextDecoder().decode(rest.get("license.txt") ?? new Uint8Array()),
        ...("extraLicenses" in entry ? entry.extraLicenses.map((file) => readFileSync(join(dir, "licenses", file), "utf8")) : []),
      ].join("\n\n"),
      source: entry.source,
      upstream: entry.upstream,
      modification:
        "modification" in entry
          ? entry.modification
          : "none to the program; the files of the core archive are repacked into a deflate container (build/container.mts) and its JS glue is served as a separate file",
    });
    if ("retroarch" in entry) {
      notices.push({
        name: "RetroArch (the EmulatorJS fork)",
        version: entry.retroarch.slice(0, 7),
        role: `the libretro frontend statically linked into the ${CORE_TITLES[entry.core]} core's WebAssembly (the FCEUmm and mGBA cores link a build of it too, as EmulatorJS ships them)`,
        license: "GPL-3.0-or-later",
        licenseText: readFileSync(join(dir, "licenses", "GPL-3.0.txt"), "utf8"),
        source: `https://github.com/EmulatorJS/RetroArch/tree/${entry.retroarch}`,
        upstream: "https://github.com/libretro/RetroArch",
        modification: "none; built with its own Makefile.emulatorjs, the command in apps/locadora/vendor/emulatorjs-core-bsnes/source/build.sh",
      });
    }
  }

  // bundled into the app's own script by Vite: the `.locadora` file is a zip (src/bundle.ts)
  const fflateDir = packageDir("fflate");
  notices.push({
    name: "fflate",
    version: version(fflateDir),
    role: "reads and writes the zip of a .locadora file (saves moved to another device)",
    license: "MIT",
    licenseText: readFileSync(join(fflateDir, "LICENSE"), "utf8"),
    source: "https://github.com/101arrowz/fflate",
    modification: "none",
  });

  notices.push(...fontNotices((file) => readFileSync(new URL(`./src/fonts/${file}`, import.meta.url), "utf8")));

  put(out, "ejs/emulator.min.js", patchFrontend(readFrontend(frontendDir)));
  put(
    out,
    "ejs/core-sri.js",
    `window.PQP_CORE_JS_SRI = Object.freeze(${JSON.stringify(Object.fromEntries(Object.entries(sri).sort()))});\n`,
  );
  put(out, "notices.txt", renderNotices(notices, "https://github.com/rafaelcg/pqp"));
}
