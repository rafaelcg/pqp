import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { displayRequestAllowed, normalizeOrigin } = require("./display-origin.js");

describe("displayRequestAllowed", () => {
  const allowed = "https://pqp.gg";

  it("accepts Chromium's trailing-slash securityOrigin for the app origin (the 0.1.6 regression)", () => {
    assert.equal(displayRequestAllowed({ securityOrigin: "https://pqp.gg/" }, allowed), true);
  });

  it("accepts an origin without a trailing slash", () => {
    assert.equal(displayRequestAllowed({ securityOrigin: "https://pqp.gg" }, allowed), true);
  });

  it("accepts when allowedOrigin itself carries a path or slash", () => {
    assert.equal(displayRequestAllowed({ securityOrigin: "https://pqp.gg/" }, "https://pqp.gg/app"), true);
  });

  it("refuses another origin, including a lookalike host", () => {
    assert.equal(displayRequestAllowed({ securityOrigin: "https://evil.example/" }, allowed), false);
    assert.equal(displayRequestAllowed({ securityOrigin: "https://pqp.gg.evil.example/" }, allowed), false);
    assert.equal(displayRequestAllowed({ securityOrigin: "http://pqp.gg/" }, allowed), false);
  });

  it("falls back to the frame URL when securityOrigin is missing", () => {
    assert.equal(displayRequestAllowed({ frame: { url: "https://pqp.gg/app/server/x" } }, allowed), true);
    assert.equal(displayRequestAllowed({ frame: { url: "https://steamcommunity.com/openid" } }, allowed), false);
  });

  it("refuses when nothing identifies the requester or the allowed origin is unknown", () => {
    assert.equal(displayRequestAllowed({}, allowed), false);
    assert.equal(displayRequestAllowed(undefined, allowed), false);
    assert.equal(displayRequestAllowed({ securityOrigin: "https://pqp.gg/" }, null), false);
    assert.equal(displayRequestAllowed({ securityOrigin: "https://pqp.gg/" }, "not a url"), false);
  });

  it("works for the packaged static server origin", () => {
    assert.equal(displayRequestAllowed({ securityOrigin: "http://127.0.0.1:41733/" }, "http://127.0.0.1:41733/app"), true);
  });

  it("normalizeOrigin returns null for garbage", () => {
    assert.equal(normalizeOrigin(""), null);
    assert.equal(normalizeOrigin(42), null);
    assert.equal(normalizeOrigin("nope"), null);
  });
});
