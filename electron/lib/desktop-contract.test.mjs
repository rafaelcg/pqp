import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadSource = readFileSync(path.join(here, "..", "preload.js"), "utf8");
const contractSource = readFileSync(
  path.join(here, "..", "..", "client", "src", "lib", "desktop.ts"),
  "utf8",
);

/**
 * THE WEB CLIENT AND THE SHELL ARE ONE PRODUCT, AND NOTHING CHECKED THAT.
 *
 * `PqpDesktop` in `client/src/lib/desktop.ts` is what the renderer is allowed
 * to call. `preload.js` is what the shell actually hands it. Every member on
 * that interface past `isElectron` is optional, so the renderer type-checks
 * whether or not the shell implements any of them, and a missing one shows up
 * only as a feature that quietly does nothing: push-to-talk that never fires,
 * a tray that never learns you are in a call, a sign-in that never opens.
 *
 * The optionality is not a mistake. It is there for shells that are already
 * installed on somebody's machine, which the hosted client has to run inside.
 * But the shell built from THIS commit ships alongside this client, so within
 * the repo the two are not allowed to differ, and that is what this asserts.
 *
 * Costs nothing: it reads two files. It runs in the existing
 * `node --test lib/*.test.mjs`, which CI already runs for this package.
 */

/** Members of the `PqpDesktop` interface, optional ones included. */
function contractMembers(source) {
  const start = source.indexOf("export interface PqpDesktop {");
  assert.notEqual(
    start,
    -1,
    "PqpDesktop moved or was renamed. This test reads it by name, so point it at the new one rather than deleting it.",
  );
  const body = source.slice(start, source.indexOf("\n}", start));
  const names = new Set();
  // `name?(args)`, `name(args)`, `name: type` and `name?: type`, at one level
  // of indentation so nested payload shapes (`notify`'s object) do not count.
  for (const match of body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??[(:]/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** Keys the preload actually exposes on `pqpDesktop`. */
function exposedMembers(source) {
  const start = source.indexOf('exposeInMainWorld("pqpDesktop"');
  assert.notEqual(start, -1, "preload.js no longer exposes pqpDesktop.");
  const body = source.slice(start);
  const names = new Set();
  for (const match of body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*[(:]/gm)) {
    names.add(match[1]);
  }
  return names;
}

test("the shell implements everything the client is allowed to call", () => {
  const wanted = contractMembers(contractSource);
  const have = exposedMembers(preloadSource);
  assert.ok(wanted.size > 10, `parsed only ${wanted.size} members, so the parser is broken rather than the contract`);
  const missing = [...wanted].filter((name) => !have.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `client/src/lib/desktop.ts declares these, and preload.js does not expose them: ${missing.join(", ")}. ` +
      "The renderer will call them, find undefined, and skip the feature without an error.",
  );
});

test("the parser reads real members rather than matching anything", () => {
  // Guards the assertion above: a regex that quietly matched nothing would
  // make this file pass forever. These four are the shapes the interface uses.
  const wanted = contractMembers(contractSource);
  for (const name of ["platform", "isElectron", "onToggleMute", "bindPushToTalk"]) {
    assert.ok(wanted.has(name), `expected to parse ${name} out of the contract`);
  }
  // And nothing from a nested payload shape or a sibling type.
  for (const name of ["title", "tag", "inCall"]) {
    assert.ok(!wanted.has(name), `${name} is a nested field, not a member of PqpDesktop`);
  }
});
