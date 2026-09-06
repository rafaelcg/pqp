import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  statesEqual,
  isAllowedAppOrigin,
  buildLoopbackReturn,
  buildDesktopLoginUrl,
  buildDoneUrl,
  classifyCallbackRequest,
} = require("./desktop-auth.js");

const APP = "https://pqp.gg";
const STATE = "aabbccddeeff00112233445566778899";

describe("buildDesktopLoginUrl", () => {
  it("points at /desktop-login on the app origin with a loopback return", () => {
    const url = buildDesktopLoginUrl({
      appOrigin: APP,
      mode: "sign-in",
      port: 41234,
      state: STATE,
    });
    const parsed = new URL(url);
    assert.equal(parsed.origin, APP);
    assert.equal(parsed.pathname, "/desktop-login");
    assert.equal(parsed.searchParams.get("mode"), "sign-in");
    assert.equal(
      parsed.searchParams.get("return"),
      "http://127.0.0.1:41234/callback",
    );
    assert.equal(parsed.searchParams.get("state"), STATE);
  });

  it("defaults an unknown mode to sign-in", () => {
    const url = buildDesktopLoginUrl({
      appOrigin: APP,
      mode: "nope",
      port: 41234,
      state: STATE,
    });
    assert.equal(new URL(url).searchParams.get("mode"), "sign-in");
  });

  it("refuses a port outside the ephemeral range", () => {
    assert.equal(
      buildDesktopLoginUrl({
        appOrigin: APP,
        mode: "sign-in",
        port: 80,
        state: STATE,
      }),
      null,
    );
  });
});

describe("buildLoopbackReturn / isAllowedAppOrigin", () => {
  it("only builds 127.0.0.1 callback URLs", () => {
    assert.equal(buildLoopbackReturn(41234), "http://127.0.0.1:41234/callback");
    assert.equal(buildLoopbackReturn(80), null);
    assert.equal(buildLoopbackReturn(1.5), null);
  });

  it("pins openExternal to the app origin", () => {
    assert.equal(isAllowedAppOrigin("https://pqp.gg/desktop-login", APP), true);
    assert.equal(isAllowedAppOrigin("https://evil.test/desktop-login", APP), false);
    assert.equal(isAllowedAppOrigin("file:///tmp", APP), false);
  });
});

describe("buildDoneUrl", () => {
  it("stays on the app origin", () => {
    assert.equal(buildDoneUrl(APP), "https://pqp.gg/desktop-login?done=1");
  });
});

describe("statesEqual", () => {
  it("matches equal secrets and rejects the rest", () => {
    assert.equal(statesEqual(STATE, STATE), true);
    assert.equal(statesEqual(STATE, STATE.slice(0, -1) + "0"), false);
    assert.equal(statesEqual(STATE, ""), false);
    assert.equal(statesEqual("", ""), false);
  });
});

describe("classifyCallbackRequest", () => {
  const base = {
    method: "GET",
    url: `/callback?ticket=st_x&state=${STATE}`,
    host: "127.0.0.1:41234",
    expectedPort: 41234,
    expectedState: STATE,
  };

  it("accepts a matching GET /callback", () => {
    const result = classifyCallbackRequest(base);
    assert.equal(result.action, "accept");
    assert.equal(result.ticket, "st_x");
  });

  it("ignores favicon and other paths so they do not kill the listener", () => {
    assert.equal(
      classifyCallbackRequest({ ...base, url: "/favicon.ico" }).action,
      "ignore",
    );
    assert.equal(
      classifyCallbackRequest({ ...base, method: "POST" }).action,
      "ignore",
    );
  });

  it("rejects a wrong state and keeps the request classified as reject", () => {
    const result = classifyCallbackRequest({
      ...base,
      url: "/callback?ticket=st_x&state=nope",
    });
    assert.equal(result.action, "reject");
    assert.equal(result.ticket, undefined);
  });

  it("rejects a missing ticket", () => {
    assert.equal(
      classifyCallbackRequest({
        ...base,
        url: `/callback?state=${STATE}`,
      }).action,
      "reject",
    );
  });

  it("rejects a Host that is not 127.0.0.1", () => {
    assert.equal(
      classifyCallbackRequest({ ...base, host: "localhost:41234" }).action,
      "reject",
    );
    assert.equal(
      classifyCallbackRequest({ ...base, host: "evil.test:41234" }).action,
      "reject",
    );
  });
});
