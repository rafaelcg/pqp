import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { createDesktopAuthController } = require("./desktop-auth-session.js");

const APP = "https://pqp.gg";

function controller(overrides = {}) {
  const events = [];
  const opened = [];
  const auth = createDesktopAuthController({
    openExternal: async (url) => {
      opened.push(url);
    },
    send: (channel, ...args) => {
      events.push([channel, ...args]);
    },
    getAppOrigin: () => APP,
    ttlMs: 60_000,
    ...overrides,
  });
  return { auth, events, opened };
}

function loopbackFromLogin(url) {
  const parsed = new URL(url);
  const returnTo = parsed.searchParams.get("return");
  const state = parsed.searchParams.get("state");
  assert.ok(returnTo);
  assert.ok(state);
  return { returnTo, state, port: new URL(returnTo).port };
}

async function waitForTicket(auth) {
  for (let i = 0; i < 20; i++) {
    const ticket = auth.takePendingTicket();
    if (ticket) {
      return ticket;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

describe("createDesktopAuthController", () => {
  it("opens one listener when start is called twice before listen completes", async () => {
    const { auth, opened } = controller();
    try {
      const [first, second] = await Promise.all([
        auth.start("sign-in"),
        auth.start("sign-in"),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      const a = loopbackFromLogin(first.url);
      const b = loopbackFromLogin(second.url);
      assert.equal(a.port, b.port);
      assert.equal(a.state, b.state);
      assert.equal(opened.length, 2);

      const res = await fetch(
        `${a.returnTo}?ticket=st_first&state=${a.state}`,
        { redirect: "manual" },
      );
      assert.equal(res.status, 302);
      assert.equal(await waitForTicket(auth), "st_first");
    } finally {
      auth.stop();
    }
  });

  it("stashes even when send reports the window was missing", () => {
    const { auth } = controller({
      send: () => false,
    });
    auth.deliverTicket("st_missed");
    assert.equal(auth.takePendingTicket(), "st_missed");
  });

  it("stashes a delivered ticket until the renderer reads it", async () => {
    const { auth, events } = controller({
      send: (channel, ...args) => {
        events.push([channel, ...args]);
        return true;
      },
    });
    try {
      const started = await auth.start("sign-in");
      const { returnTo, state } = loopbackFromLogin(started.url);
      const res = await fetch(`${returnTo}?ticket=st_kept&state=${state}`, {
        redirect: "manual",
      });
      assert.equal(res.status, 302);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(events[0], ["pqp:desktop-auth-ticket", "st_kept"]);
      assert.equal(auth.takePendingTicket(), "st_kept");
      assert.equal(auth.takePendingTicket(), null);
    } finally {
      auth.stop();
    }
  });

  it("emits desktop-auth-ended:expired when the listener times out", async () => {
    const { auth, events } = controller({ ttlMs: 20 });
    try {
      const started = await auth.start("sign-in");
      assert.equal(started.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(
        events.find((event) => event[0] === "pqp:desktop-auth-ended"),
        ["pqp:desktop-auth-ended", "expired"],
      );
      assert.equal(auth.status().active, false);
    } finally {
      auth.stop();
    }
  });

  it("keeps the url when openExternal fails", async () => {
    const { auth } = controller({
      openExternal: async () => {
        throw new Error("no browser");
      },
    });
    try {
      const started = await auth.start("sign-in");
      assert.equal(started.ok, false);
      assert.match(started.url, /^https:\/\/pqp\.gg\/desktop-login/);
    } finally {
      auth.stop();
    }
  });
});
