import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createMacShareAudio, ARM_WINDOW_MS } = require("./mac-share-audio.js");

function make({ platform = "darwin", version = "15.1", start = 1000 } = {}) {
  let t = start;
  const audio = createMacShareAudio({
    platform,
    getSystemVersion: () => version,
    now: () => t,
  });
  return { audio, advance: (ms) => (t += ms) };
}

describe("createMacShareAudio", () => {
  it("is supported on macOS 14.2 and newer only", () => {
    assert.equal(make({ version: "14.2" }).audio.supported(), true);
    assert.equal(make({ version: "26.0" }).audio.supported(), true);
    assert.equal(make({ version: "14.1" }).audio.supported(), false);
    assert.equal(make({ version: "13.6.9" }).audio.supported(), false);
    assert.equal(make({ version: "" }).audio.supported(), false);
  });

  it("is never supported off macOS, whatever the version string says", () => {
    assert.equal(make({ platform: "win32", version: "15.1" }).audio.supported(), false);
    assert.equal(make({ platform: "linux", version: "15.1" }).audio.supported(), false);
    assert.deepEqual(make({ platform: "linux" }).audio.status(), {
      supported: false,
      version: null,
    });
  });

  it("reports its status as plain data", () => {
    assert.deepEqual(make({ version: "15.1" }).audio.status(), {
      supported: true,
      version: "15.1",
    });
    assert.deepEqual(make({ version: "13.6" }).audio.status(), {
      supported: false,
      version: "13.6",
    });
  });

  it("survives a version read that throws", () => {
    const audio = createMacShareAudio({
      platform: "darwin",
      getSystemVersion: () => {
        throw new Error("no");
      },
    });
    assert.equal(audio.supported(), false);
    assert.equal(audio.arm(), false);
  });

  it("refuses to arm on a Mac without the tap", () => {
    const { audio } = make({ version: "13.6" });
    assert.equal(audio.arm(), false);
    assert.equal(audio.consumeArm(), false);
  });

  it("an arm is good for exactly one request", () => {
    const { audio } = make();
    assert.equal(audio.consumeArm(), false, "nothing armed yet");
    assert.equal(audio.arm(), true);
    assert.equal(audio.consumeArm(), true);
    assert.equal(audio.consumeArm(), false, "spent");
  });

  it("an arm that never got its request expires", () => {
    const { audio, advance } = make();
    audio.arm();
    advance(ARM_WINDOW_MS + 1);
    assert.equal(audio.consumeArm(), false);
    audio.arm();
    advance(ARM_WINDOW_MS - 1);
    assert.equal(audio.consumeArm(), true);
  });
});
