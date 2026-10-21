import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FOUR PATCHES to the EmulatorJS frontend.
 *
 * The S0 spike (docs/APPS.md, Locadora) showed that EmulatorJS 4.2.3 does not
 * run inside the apps sandbox's policy as it ships (`script-src 'self'
 * 'wasm-unsafe-eval'`, `style-src 'self'`, `connect-src blob:`, no workers),
 * and that four small text edits make it run without ever loosening the policy
 * (no `'unsafe-eval'`, no `script-src blob:`, no `worker-src`):
 *
 *  1. `unpack`: the core archive is unpacked by `window.PQP_UNPACK` (the
 *     browser's own `DecompressionStream`, see `src/container.ts`) instead of
 *     a blob Web Worker that evals.
 *  2. `corejs`: the core's JS glue is loaded from the bundle, under Subresource
 *     Integrity (`window.PQP_CORE_JS_URL` and `window.PQP_CORE_JS_SRI`),
 *     instead of from a blob script.
 *  3. `style`: every `setAttribute("style", x)` becomes `el.style.cssText = x`
 *     (CSSOM writes are allowed, inline style attributes are not) and the one
 *     SVG icon with an inline `style="..."` gets presentation attributes.
 *  4. `noupdate`: the update check is dropped (it fetches a CDN when the page
 *     is on localhost, which is the dev server).
 *
 * Each is a needle replacement that THROWS when the needle is not found
 * exactly as many times as expected, so an EmulatorJS bump breaks the build
 * loudly and somebody re-audits it instead of shipping an unpatched file that
 * only fails in a user's browser.
 */

/** The only frontend version these needles were written against. */
export const EMULATORJS_VERSION = "4.2.3";

/**
 * The frontend's scripts, in the order its `loader.js` loads them, MINUS
 * `socket.io.min.js`: that is the client library of the netplay feature, and
 * netplay is out of scope and refused (docs/EMULATOR_ROOM.md rule 4).
 */
export const FRONTEND_SCRIPTS = [
  "emulator.js",
  "nipplejs.js",
  "shaders.js",
  "storage.js",
  "gamepad.js",
  "GameManager.js",
  "compression.js",
] as const;

export class PatchError extends Error {
  constructor(
    readonly patch: "version" | "unpack" | "corejs" | "style" | "noupdate",
    message: string,
  ) {
    super(`EmulatorJS patch "${patch}": ${message}. EmulatorJS changed: re-audit the patches in apps/locadora/build/patch.mts (S0 spike notes in docs/APPS.md) before bumping.`);
    this.name = "PatchError";
  }
}

const UNPACK_NEEDLE = "const compressed = this.isCompressed(data.slice(0, 10));";
const COREJS_NEEDLE = 'script.src = URL.createObjectURL(new Blob([js], { type: "application/javascript" }));';
const NOUPDATE_NEEDLE = "this.checkForUpdates();";
const STYLE_ATTR = /(\b[\w.]+)\.setAttribute\("style",\s*/g;
const SVG_INLINE_STYLE =
  'style="fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round;stroke:rgb(255,255,255);stroke-opacity:1;stroke-miterlimit:4;"';
const SVG_PRESENTATION =
  'fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke="rgb(255,255,255)" stroke-opacity="1" stroke-miterlimit="4"';

/** How many `setAttribute("style", ...)` calls 4.2.3 has: the background (two), the colour (two) and the volume slider. */
export const EXPECTED_STYLE_CALLS = 5;

/** The one SVG icon (the settings gear's neighbour) draws two paths with the same inline style. */
export const EXPECTED_SVG_STYLES = 2;

function once(source: string, needle: string, patch: PatchError["patch"]): void {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new PatchError(patch, `expected its needle exactly once, found ${count}`);
}

/** Splices without `$` patterns: `String.replace` would read `$&` in a replacement as a match reference. */
function replaceOnce(source: string, needle: string, replacement: string): string {
  const at = source.indexOf(needle);
  return source.slice(0, at) + replacement + source.slice(at + needle.length);
}

export function patchFrontend(source: string): string {
  let js = source;

  once(js, UNPACK_NEEDLE, "unpack");
  js = replaceOnce(
    js,
    UNPACK_NEEDLE,
    // "PQPC1": a ZIP starts "PK", so nothing the frontend itself unpacks is taken for ours
    'if (data[0] === 80 && data[1] === 81 && data[2] === 80 && data[3] === 67 && data[4] === 49 && typeof window.PQP_UNPACK === "function") {\n' +
      "            return window.PQP_UNPACK(data).then(function (files) {\n" +
      '                if (typeof fileCbFunc === "function") { Object.keys(files).forEach(function (k) { fileCbFunc(k, files[k]); }); }\n' +
      "                return files;\n" +
      "            });\n" +
      "        }\n        " +
      UNPACK_NEEDLE,
  );

  once(js, COREJS_NEEDLE, "corejs");
  js = replaceOnce(
    js,
    COREJS_NEEDLE,
    // a core's glue is code: from the bundle, with its hash, or not at all
    "if (window.PQP_CORE_JS_URL) {\n" +
      "            const sri = window.PQP_CORE_JS_SRI && window.PQP_CORE_JS_SRI[this.getCore()];\n" +
      '            if (typeof sri !== "string") throw new Error("no integrity for the core script");\n' +
      '            script.crossOrigin = "anonymous";\n' +
      "            script.integrity = sri;\n" +
      "            script.src = window.PQP_CORE_JS_URL;\n" +
      "        } else {\n" +
      '            script.src = URL.createObjectURL(new Blob([js], { type: "application/javascript" }));\n' +
      "        }",
  );

  const styleCalls = [...js.matchAll(STYLE_ATTR)].length;
  if (styleCalls !== EXPECTED_STYLE_CALLS) {
    throw new PatchError("style", `expected ${EXPECTED_STYLE_CALLS} setAttribute("style") calls, found ${styleCalls}`);
  }
  const svgCount = js.split(SVG_INLINE_STYLE).length - 1;
  if (svgCount !== EXPECTED_SVG_STYLES) {
    throw new PatchError("style", `expected ${EXPECTED_SVG_STYLES} inline-style SVG paths, found ${svgCount}`);
  }
  js = js.split(SVG_INLINE_STYLE).join(SVG_PRESENTATION);
  js = js.replace(STYLE_ATTR, (_match, element: string) => `(function (e, v) { e.style.cssText = v; })(${element}, `);
  // a `style=` inside markup (`let style = "";` in the code is not one)
  if (/setAttribute\(\s*["']style["']/.test(js) || /<[a-zA-Z][^>]*\sstyle\s*=\s*["']/.test(js)) {
    throw new PatchError("style", "an inline style is still there after the patch");
  }

  once(js, NOUPDATE_NEEDLE, "noupdate");
  js = replaceOnce(js, NOUPDATE_NEEDLE, "");

  return js;
}

/** The frontend as one script (what a published release ships and the npm package leaves out), unpatched. */
export function readFrontend(frontendDir: string): string {
  const version = (JSON.parse(readFileSync(join(frontendDir, "package.json"), "utf8")) as { version?: string }).version;
  if (version !== EMULATORJS_VERSION) {
    throw new PatchError("version", `the patches are for ${EMULATORJS_VERSION}, the installed frontend is ${version}`);
  }
  return FRONTEND_SCRIPTS.map((name) => readFileSync(join(frontendDir, "data", "src", name), "utf8")).join(";\n");
}
