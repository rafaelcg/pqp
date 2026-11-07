/**
 * Find the `ws` the server runs, and load the two internal modules the parity
 * harness needs.
 *
 * `ws` 8 restricts its `exports` map to `.` and `./package.json`, so
 * `require("ws/lib/permessage-deflate.js")` is refused even though the file is
 * on disk: the class is internal to the package, which is why it is not
 * exported. It is still the exact code the server loads, so it is located by
 * directory and required by path. Requiring the module a package's own entry
 * point requires is not a reimplementation; guessing the framing from RFC 7692
 * is, and a harness that guessed would test its own guess.
 *
 * The version is checked against `pnpm-lock.yaml` before it is used. A git
 * worktree symlinks `node_modules` to the primary checkout, so the path can land
 * outside the worktree; that is only acceptable when it is the version the
 * lockfile pins, and callers record the version and path in their fixtures so a
 * stale store is visible rather than merely plausible.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function locateWs(root) {
  const anchors = ["server/package.json", "package.json"];
  for (const anchor of anchors) {
    try {
      const pkg = createRequire(join(root, anchor)).resolve("ws/package.json");
      return { dir: dirname(pkg), how: anchor };
    } catch {
      // Not installed relative to this anchor; try the next one.
    }
  }
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const pinned = [...lock.matchAll(/^ {2}ws@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]);
  const store = join(root, "node_modules/.pnpm");
  const candidates = (existsSync(store) ? readdirSync(store) : [])
    .filter((name) => name.startsWith("ws@"))
    .map((name) => join(store, name, "node_modules", "ws"))
    .filter((dir) => existsSync(join(dir, "lib", "permessage-deflate.js")));
  const chosen =
    candidates.find(
      (dir) => pinned.includes(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version),
    ) ?? candidates[0];
  if (!chosen) {
    throw new Error(
      "cannot find the installed ws package. Run `pnpm install`. Refusing to write or verify " +
        "deflate fixtures from anything other than the ws the server runs.",
    );
  }
  return { dir: chosen, how: "node_modules/.pnpm" };
}

/**
 * `{ PerMessageDeflate, extension, package, dir, how }` for the located `ws`.
 *
 * `extension` is the header parser and formatter, so a harness that uses it is
 * negotiating through the same code path `websocket-server.js` uses rather than
 * hand-building the array-shaped parameter objects `accept()` insists on.
 */
export function loadWs(root) {
  const found = locateWs(root);
  const require = createRequire(join(root, "server/package.json"));
  return {
    ...found,
    PerMessageDeflate: require(join(found.dir, "lib", "permessage-deflate.js")),
    extension: require(join(found.dir, "lib", "extension.js")),
    package: require(join(found.dir, "package.json")),
  };
}
