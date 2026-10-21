import { afterEach, describe, expect, it, vi } from "vitest";
import { seatIdSchema } from "@pqp/shared";
import { BridgeHost } from "./bridge-host";
import { AppSide, FakeTheme, baseApp, pngFetch } from "./bridge-host.fixture";
import { DeviceStore, openIdbBackend } from "./device-store";
import { createFakeIdb } from "./fake-idb.fixture";
import {
  GUEST_SESSION_ID,
  createGuestTransport,
  guestStoreName,
  guestUserDirectory,
  randomGuestSeatId,
} from "./guest-session";

/**
 * The guest player's half of the bridge: a session that lives in the page (one
 * person, the host), a hello that says `guest: true`, no account saves, no
 * share, a device store of its own, and `ui.activity` reaching the page.
 */

const hosts: BridgeHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.detach();
});

const LOCADORA = baseApp({
  id: "pqp-locadora",
  version: "1.0.1",
  capabilities: {
    share: "pane",
    localFiles: { allowed: true, accept: [".nes", ".sfc", ".locadora"], maxBytes: 1024 },
    deviceStore: { allowed: true, maxBytes: 4096 },
  },
  state: { maxBytes: 0, maxWritesPerSecond: 1, writers: "participants" },
  events: { maxPerSecond: 0, maxBytes: 0 },
  shareAllowed: false,
});

async function guestRig(options: { onActivity?: (state: string) => void; fetchImpl?: typeof fetch } = {}) {
  const idb = createFakeIdb();
  const opened: string[] = [];
  const transport = createGuestTransport();
  const fetchImpl = options.fetchImpl ?? vi.fn(pngFetch());
  const host = new BridgeHost({
    app: LOCADORA,
    transport,
    users: guestUserDirectory(() => "Visitante"),
    locale: () => "pt-BR",
    theme: new FakeTheme(),
    fetchImpl,
    appsOrigin: "http://localhost:5175",
    guest: true,
    saveSync: null,
    openStore: (appId, cap) => {
      opened.push(appId);
      return new DeviceStore({ backend: openIdbBackend(guestStoreName(appId), idb.env), capBytes: cap, storage: null });
    },
    onActivity: options.onActivity,
    log: () => {},
  });
  hosts.push(host);
  await host.start();
  const channel = new MessageChannel();
  const app = new AppSide(channel.port2);
  host.attach(channel.port1);
  await app.hello;
  return { host, app, transport, opened, fetchImpl };
}

describe("the guest session", () => {
  it("seats one person, the host, under a random seat id the bridge accepts", async () => {
    const snapshot = await createGuestTransport().join({});
    expect(snapshot.sessionId).toBe(GUEST_SESSION_ID);
    expect(seatIdSchema.safeParse(snapshot.seatId).success).toBe(true);
    expect(snapshot).toMatchObject({ role: "player", isHost: true });
    expect(snapshot.participants).toHaveLength(1);
    expect(randomGuestSeatId()).not.toBe(randomGuestSeatId());
  });

  it("applies a state patch in the page and pushes it back in order", async () => {
    const transport = createGuestTransport();
    const states: Array<[number, unknown]> = [];
    transport.subscribe({
      onSession: () => {},
      onState: (rev, value) => states.push([rev, value]),
      onEvent: () => {},
      onConnection: () => {},
      onEnded: () => {},
    });
    expect(await transport.patchState({ a: 1 }, undefined)).toEqual({ rev: 1 });
    expect(await transport.patchState({ b: 2 }, undefined)).toEqual({ rev: 2 });
    await Promise.resolve();
    expect(states).toEqual([
      [1, { a: 1 }],
      [2, { a: 1, b: 2 }],
    ]);
  });

  it("closing it ends the frame once", () => {
    const transport = createGuestTransport();
    const ended = vi.fn();
    transport.subscribe({ onSession: () => {}, onState: () => {}, onEvent: () => {}, onConnection: () => {}, onEnded: ended });
    transport.close();
    transport.close();
    void transport.end();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith("host");
  });
});

describe("a guest frame host", () => {
  it("tells the app it is a guest, and an ordinary host never does", async () => {
    const { app } = await guestRig();
    expect(await app.hello).toMatchObject({ type: "hello", guest: true, self: { role: "player", isHost: true } });
    const plain = new BridgeHost({
      app: LOCADORA,
      transport: createGuestTransport(),
      users: guestUserDirectory(() => "x"),
      locale: () => "en",
      theme: new FakeTheme(),
      appsOrigin: "http://localhost:5175",
      log: () => {},
    });
    hosts.push(plain);
    await plain.start();
    const channel = new MessageChannel();
    const side = new AppSide(channel.port2);
    plain.attach(channel.port1);
    expect(await side.hello).not.toHaveProperty("guest");
  });

  it("refuses account saves and the share without asking anybody", async () => {
    const fetchImpl = vi.fn(pngFetch());
    const { app } = await guestRig({ fetchImpl });
    expect(await app.call({ type: "sync.status" })).toMatchObject({ ok: false, error: "not-allowed" });
    expect(await app.call({ type: "sync.list", game: "a".repeat(64) })).toMatchObject({ ok: false, error: "not-allowed" });
    expect(await app.call({ type: "share.request", on: true })).toMatchObject({ ok: false, error: "not-allowed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the shelf in the guest's own store, apart from the account's", async () => {
    const { app, opened } = await guestRig();
    const put = await app.call({ type: "store.put", key: "prefs", bytes: new Uint8Array([1, 2, 3]).buffer });
    expect(put).toMatchObject({ ok: true, type: "store.put" });
    expect(opened).toEqual(["pqp-locadora"]);
    expect(guestStoreName("pqp-locadora")).toBe("guest:pqp-locadora");
    expect(await app.call({ type: "store.usage" })).toMatchObject({ ok: true, result: { used: 3, cap: 4096 } });
  });

  it("tells the page what the person is doing, as a closed state and nothing more", async () => {
    const seen: string[] = [];
    const { app } = await guestRig({ onActivity: (state) => seen.push(state) });
    for (const state of ["playing", "paused", "playing", "browsing"]) {
      expect(await app.call({ type: "ui.activity", state })).toMatchObject({ ok: true, type: "ui.activity", result: null });
    }
    expect(await app.call({ type: "ui.activity", state: "watching a title" })).toMatchObject({ ok: false, error: "invalid" });
    expect(seen).toEqual(["playing", "paused", "playing", "browsing"]);
  });

  it("an ordinary host answers ui.activity too, so an app never needs to know which host it has", async () => {
    const { app } = await guestRig();
    expect(await app.call({ type: "ui.activity", state: "paused" })).toMatchObject({ ok: true });
  });
});
