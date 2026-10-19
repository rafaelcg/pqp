// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarCache, acceptableFinalUrl, fetchAvatarDataUrl } from "./avatar";
import { mountAppFrame } from "./frame-controller";
import { FakeTheme, FakeTransport, PNG_BYTES, baseApp, baseSnapshot, rig, users, type Rig } from "./bridge-host.fixture";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.host.detach();
  document.body.replaceChildren();
  document.head.querySelectorAll("meta").forEach((meta) => meta.remove());
});

describe("participants.get during a roster refresh", () => {
  it("answers with the latest roster even when a newer snapshot lands while it waits", async () => {
    // every avatar takes a moment, so the first refresh is still running when the second snapshot arrives
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(PNG_BYTES as BodyInit, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const r = await rig({ host: { fetchImpl: slow } });
    rigs.push(r);
    const asked = r.app.call({ type: "participants.get" });
    r.transport.handlers!.onSession(
      baseSnapshot({ participants: baseSnapshot().participants.map((p) => ({ ...p, connection: "reconnecting" as const })) }),
    );
    const answer = await asked;
    const list = (answer.result as { participants: Array<{ connection: string }> }).participants;
    expect(list.length).toBe(2);
    expect(list.every((p) => p.connection === "reconnecting")).toBe(true);
  });
});

describe("the avatar cache", () => {
  it("holds a bounded number of URLs: the oldest are dropped, the recent ones are kept", async () => {
    const fetchImpl = vi.fn(async () => new Response(PNG_BYTES as BodyInit, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const cache = new AvatarCache(fetchImpl, ["https://pqp.example"]);
    for (let i = 0; i < 350; i += 1) await cache.get(`https://pqp.example/a/${i}`);
    expect(fetchImpl).toHaveBeenCalledTimes(350);
    await cache.get("https://pqp.example/a/349"); // recent: still cached
    expect(fetchImpl).toHaveBeenCalledTimes(350);
    await cache.get("https://pqp.example/a/0"); // old: dropped, fetched again
    expect(fetchImpl).toHaveBeenCalledTimes(351);
  });
});

describe("where an avatar may finally come from", () => {
  it("accepts the same origin and a public https destination, refuses http, local and literal addresses", () => {
    const asked = "https://api.pqp.example/api/avatars/x";
    expect(acceptableFinalUrl(asked, asked)).toBe(true);
    expect(acceptableFinalUrl("https://bucket.r2.example/x.png?sig=1", asked)).toBe(true);
    for (const bad of [
      "http://bucket.example/x.png",
      "https://localhost/x.png",
      "https://127.0.0.1/x.png",
      "https://10.0.0.5/x.png",
      "https://192.168.1.1/x.png",
      "https://[::1]/x.png",
      "not a url",
    ]) {
      expect(acceptableFinalUrl(bad, asked), bad).toBe(false);
    }
  });

  it("drops an avatar whose redirect ended somewhere unacceptable", async () => {
    const redirectedTo = (url: string) =>
      (async () => ({
        ok: true,
        redirected: true,
        url,
        headers: new Headers({ "content-type": "image/png" }),
        body: null,
        arrayBuffer: async () => PNG_BYTES.buffer,
      })) as unknown as typeof fetch;
    // only pqp's own avatar route follows a redirect (see the redirect tests in bridge-host-hardening)
    const route = "https://api.pqp.example/api/avatars/00000000-0000-4000-8000-000000000001?v=1";
    expect(await fetchAvatarDataUrl(route, redirectedTo("http://192.168.0.2/x.png"))).toBeNull();
    expect(await fetchAvatarDataUrl(route, redirectedTo("https://bucket.example/x.png"))).toMatch(/^data:image\/png/);
  });
});

describe("a frame destroyed while its join is pending", () => {
  it("releases the seat when the join lands afterwards", async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    transport.join = () =>
      new Promise((resolve) => {
        release = () => resolve(transport.snapshot);
      });
    const container = document.createElement("div");
    document.body.append(container);
    const controller = mountAppFrame({
      container,
      app: baseApp(),
      appsOrigin: "http://localhost:5175",
      title: "Eco",
      transport,
      users,
      locale: () => "en",
      host: { theme: new FakeTheme() },
    });
    controller.destroy();
    expect(transport.left).toBe(0); // no seat yet
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.left).toBe(1);
  });
});
