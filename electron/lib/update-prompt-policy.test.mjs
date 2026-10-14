import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { decideUpdatePrompt } = require("./update-prompt-policy.js");

const base = { version: "0.2.7", declinedVersion: null, promptOpen: false, inCall: false };

describe("decideUpdatePrompt", () => {
  it("shows the box for a fresh update when nobody is busy", () => {
    assert.equal(decideUpdatePrompt(base), "show");
  });

  it("does not show a second box over an open one", () => {
    assert.equal(decideUpdatePrompt({ ...base, promptOpen: true }), "skip");
  });

  it("treats Later as an answer: the same version is not offered again this run", () => {
    assert.equal(decideUpdatePrompt({ ...base, declinedVersion: "0.2.7" }), "skip");
    // Even in a call: there is nothing to wait for.
    assert.equal(decideUpdatePrompt({ ...base, declinedVersion: "0.2.7", inCall: true }), "skip");
  });

  it("offers a NEWER version again", () => {
    assert.equal(decideUpdatePrompt({ ...base, declinedVersion: "0.2.6" }), "show");
  });

  it("never puts a modal box over a call: it waits and asks again", () => {
    assert.equal(decideUpdatePrompt({ ...base, inCall: true }), "wait");
  });
});
