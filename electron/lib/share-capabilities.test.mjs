import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(path.join(here, "..", ...parts), "utf8");
const preload = read("preload.js");
const main = read("main.js");
const pkg = JSON.parse(read("package.json"));
const clientContract = readFileSync(
  path.join(here, "..", "..", "client", "src", "lib", "desktop.ts"),
  "utf8",
);

/**
 * THE PROMISES THIS BINARY MAKES TO THE WEB CLIENT, READ OFF THE SOURCE.
 *
 * `capabilities` is a literal in a sandboxed preload: it cannot `require` a
 * local module, so there is no function to unit-test and the only way to pin it
 * is to read the file, the way `server/src/ws/heartbeat.test.ts` reads the
 * entry point. The point is not the parsing. It is that each of these is a
 * promise the renderer now DECIDES things on, and the renderer ships on its own
 * release cycle: a promise this build cannot keep is a share that fails in a
 * way only the user ever sees.
 */
describe("the share capabilities the preload publishes", () => {
  it("says this shell answers getDisplayMedia", () => {
    assert.match(preload, /displayMedia:\s*true/);
  });

  it("promises loopback audio on Windows only", () => {
    // Chromium's loopback device is WASAPI. Promising it anywhere else is not a
    // silent share, it is a rejected capture: an audio request the embedder
    // cannot satisfy takes the video with it (3 Sep 2026).
    assert.match(
      preload,
      /systemAudio:\s*process\.platform === "win32" \? "loopback" : "none"/,
    );
  });

  it("promises the picker asks about audio only where there is audio to ask about", () => {
    assert.match(preload, /pickerOffersAudio:\s*process\.platform === "win32"/);
  });

  it("only claims restrictOwnAudio while Electron is new enough to honour it", () => {
    // Electron remaps Windows `"loopback"` to `loopbackWithoutChrome` when the
    // page asked `restrictOwnAudio`, from 43.4.0. That remap is the only thing
    // keeping the call itself out of the tap (the 23 Aug 2026 echo), and the
    // client offers computer audio BECAUSE of this claim. A downgrade below
    // 43.4 has to fail here rather than in somebody's call.
    const claimed = /restrictOwnAudio:\s*true/.test(preload);
    const pinned = pkg.devDependencies?.electron ?? "";
    const [major, minor = "0"] = pinned.replace(/^[^\d]*/, "").split(".");
    const version = Number(major) + Number(minor) / 1000;
    assert.ok(
      !claimed || version >= 43.004,
      `preload claims restrictOwnAudio while package.json pins electron ${pinned}`,
    );
  });

  it("never asks for loopbackWithMute", () => {
    // It captures the same tap and silences the machine's output while it does,
    // so the presenter stops hearing the call and the film. Excluding our own
    // output is `restrictOwnAudio`, a different device.
    // Quoted, because both files say the name in prose to explain why not.
    assert.ok(!/["']loopbackWithMute["']/.test(preload));
    assert.ok(!/["']loopbackWithMute["']/.test(main));
  });

  it("is declared on the client's side of the bridge too", () => {
    // `desktop-contract.test.mjs` checks the other direction (everything the
    // client may call, the shell exposes). This checks that the shape the
    // client reads off `capabilities` is the shape published here.
    for (const field of [
      "displayMedia",
      "systemAudio",
      "restrictOwnAudio",
      "pickerOffersAudio",
      "version",
    ]) {
      assert.match(
        clientContract,
        new RegExp(`\\n\\s+${field}:`),
        `DesktopShareCapabilities is missing ${field}`,
      );
    }
  });
});

describe("who answers a display-media request", () => {
  it("is this shell's own handler, on every platform", () => {
    // `useSystemPicker: true` meant Electron never called our handler on macOS,
    // so the permission diagnosis, the labelled picker, the auto-pick and the
    // loopback mapping were dead code there and every test of them was testing
    // a path that platform did not take. Pitfalls 9 and 12, the same shape: the
    // flag that changes the code path was not the flag the tests exercised.
    assert.match(main, /setDisplayMediaRequestHandler/);
    assert.match(main, /useSystemPicker:\s*false/);
    assert.ok(
      !/useSystemPicker:\s*true/.test(main),
      "the system picker skips the handler entirely; nothing below it would run",
    );
  });

  it("asks desktopCapturer for windows as well as screens", () => {
    // `["screen"]` alone is why a single window could never be shared and a
    // second monitor was unreachable behind `sources[0]`.
    assert.match(main, /types:\s*\["screen",\s*"window"\]/);
  });

  it("hands the shell's version to the preload", () => {
    // A sandboxed preload cannot call `app.getVersion()`; without this argument
    // `capabilities.version` is null and every diagnosis loses the build number.
    assert.match(main, /additionalArguments:\s*\[`--pqp-shell-version=\$\{app\.getVersion\(\)\}`\]/);
    assert.match(preload, /--pqp-shell-version=/);
  });
});
