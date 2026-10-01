import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { summariseGpuStatus, formatGpuStatusLine, isEnabledValue } = require("./gpu-status.js");

describe("summariseGpuStatus", () => {
  it("reads hardware video encode off the enabled family of values", () => {
    for (const value of ["enabled", "enabled_on", "enabled_readback"]) {
      assert.equal(summariseGpuStatus({ video_encode: value }).hardwareVideoEncode, true);
    }
  });

  it("reads every software fallback and every off as not hardware", () => {
    for (const value of ["disabled_software", "disabled_off", "unavailable_software", "unavailable_off"]) {
      assert.equal(summariseGpuStatus({ video_encode: value }).hardwareVideoEncode, false);
    }
  });

  it("says unknown, not software, when Chromium gave no answer", () => {
    assert.equal(summariseGpuStatus({}).hardwareVideoEncode, null);
    assert.equal(summariseGpuStatus(null).hardwareVideoEncode, null);
    assert.equal(summariseGpuStatus(undefined).videoEncode, null);
  });

  it("keeps the named features and drops values that are not strings", () => {
    const summary = summariseGpuStatus({
      video_encode: "enabled",
      video_decode: "enabled",
      gpu_compositing: "disabled_software",
      odd: 3,
    });
    assert.equal(summary.videoDecode, "enabled");
    assert.equal(summary.gpuCompositing, "disabled_software");
    assert.deepEqual(Object.keys(summary.status).sort(), ["gpu_compositing", "video_decode", "video_encode"]);
  });
});

describe("formatGpuStatusLine", () => {
  it("is one line and shouts about a software encoder", () => {
    const line = formatGpuStatusLine(summariseGpuStatus({ video_encode: "disabled_software" }), "win32");
    assert.ok(!line.includes("\n"));
    assert.match(line, /video_encode=disabled_software \(SOFTWARE\)/);
    assert.match(formatGpuStatusLine(summariseGpuStatus({ video_encode: "enabled" }), "win32"), /\(hardware\)/);
    assert.match(formatGpuStatusLine(summariseGpuStatus(null), "linux"), /\(unknown\)/);
  });
});

describe("isEnabledValue", () => {
  it("is strict about the prefix", () => {
    assert.equal(isEnabledValue("enabled_on"), true);
    assert.equal(isEnabledValue("disabled_on"), false);
    assert.equal(isEnabledValue(true), false);
  });
});
