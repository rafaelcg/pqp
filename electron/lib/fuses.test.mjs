import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, "..", ...parts), "utf8");
const pkg = JSON.parse(read("package.json"));
const main = read("main.js");
const fuses = pkg.build?.electronFuses ?? {};

/**
 * THE 0.2.8 SHARE OUTAGE (27 Oct 2026), PINNED.
 *
 * 0.2.8 turned the `GrantFileProtocolExtraPrivileges` fuse off on the reading
 * that the share picker is the only `file://` page and needs no `fetch`. Both
 * halves were true and the conclusion was wrong: the picker lives INSIDE
 * `app.asar`, and reading a `file://` URL out of an asar archive is one of the
 * extra privileges that fuse grants. With it off, Chromium's plain file
 * handler answers `ERR_FILE_NOT_FOUND` for `app.asar/picker/index.html`, the
 * picker window never loads, `showSourcePicker` resolves null, the display
 * media handler calls `callback(null)`, and Electron turns that into
 * `AbortError: Invalid capture constraints` before anybody sees a picker.
 * Every share on every packaged build failed that way. Reproduced with the
 * released 0.2.8 mac build and with a stock Electron 44.9.1 where that one
 * fuse is flipped and nothing else (the other three fuses do not matter).
 *
 * Unpackaged runs, the smoke specs and every unit test load the picker from a
 * real directory, where the fuse changes nothing, which is why none of them
 * saw it. So this is read off the config: while the picker is a `loadFile`
 * from the app's own directory, the fuse that lets that load read the asar
 * must stay on.
 */
describe("Electron fuses vs the share picker", () => {
  it("the share picker is still loaded with loadFile from inside the app", () => {
    // If this stops matching, the picker moved (a custom protocol, say) and
    // the assertion below needs to be re-derived, not deleted.
    assert.match(main, /loadFile\(path\.join\(__dirname, "picker", "index\.html"\)\)/);
  });

  it("keeps GrantFileProtocolExtraPrivileges on, or the picker cannot load from app.asar", () => {
    assert.notEqual(
      fuses.grantFileProtocolExtraPrivileges,
      false,
      "grantFileProtocolExtraPrivileges: false makes file:// inside app.asar unreadable: " +
        "the share picker fails to load and every share ends in 'Invalid capture constraints'",
    );
  });

  it("still keeps the three Node-facing fuses off", () => {
    assert.equal(fuses.runAsNode, false);
    assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false);
    assert.equal(fuses.enableNodeCliInspectArguments, false);
  });
});
