import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { senderMatchesAppOrigin } = require("./ipc-origin.js");

const APP = "https://pqp.gg";

describe("senderMatchesAppOrigin", () => {
  it("allows the app origin, including a path on that origin", () => {
    assert.equal(
      senderMatchesAppOrigin(
        { senderFrame: { url: "https://pqp.gg/app" } },
        APP,
      ),
      true,
    );
  });

  it("refuses a third-party auth host that navigated in-window", () => {
    assert.equal(
      senderMatchesAppOrigin(
        { senderFrame: { url: "https://accounts.google.com/o/oauth2" } },
        APP,
      ),
      false,
    );
    assert.equal(
      senderMatchesAppOrigin(
        { senderFrame: { url: "https://github.com/login" } },
        APP,
      ),
      false,
    );
  });

  it("refuses a missing frame, a missing origin, and a malformed URL", () => {
    assert.equal(senderMatchesAppOrigin({}, APP), false);
    assert.equal(
      senderMatchesAppOrigin({ senderFrame: { url: "https://pqp.gg/app" } }, null),
      false,
    );
    assert.equal(
      senderMatchesAppOrigin({ senderFrame: { url: "not a url" } }, APP),
      false,
    );
  });

  it("does not treat a different port as the same origin", () => {
    assert.equal(
      senderMatchesAppOrigin(
        { senderFrame: { url: "http://localhost:5173/app" } },
        "http://localhost:3001",
      ),
      false,
    );
    assert.equal(
      senderMatchesAppOrigin(
        { senderFrame: { url: "http://localhost:5173/app" } },
        "http://localhost:5173",
      ),
      true,
    );
  });
});
