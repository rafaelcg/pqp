import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_AVATAR_MAX_CHARS, APP_PARTICIPANTS_AVATAR_BUDGET_CHARS } from "@pqp/shared";
import { BridgeHost } from "./bridge-host";
import { fetchAvatarDataUrl } from "./avatar";
import { ASSET_HEADERS_TIMEOUT_MS, ASSET_IDLE_TIMEOUT_MS, fetchAsset } from "./asset-fetch";
import { readLimited } from "./limited-body";
import {
  FakeTheme,
  FakeTransport,
  baseApp,
  baseSnapshot,
  pngFetch,
  rig,
  users,
  type Rig,
} from "./bridge-host.fixture";
import { AppTransportError } from "./types";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.host.detach();
});

const sha = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A response whose body is a stream we can watch being cancelled. */
function streamed(chunks: Uint8Array[], onCancel: () => void, headers: Record<string, string> = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
    cancel: onCancel,
  });
  return new Response(body, { headers });
}

describe("readLimited", () => {
  it("returns a body within the limit", async () => {
    expect(Array.from((await readLimited(new Response(new Uint8Array([1, 2, 3])), 3))!)).toEqual([1, 2, 3]);
  });

  it("refuses a declared length over the limit without reading, and stops a stream at the limit", async () => {
    const cancelled = vi.fn();
    expect(
      await readLimited(streamed([new Uint8Array(10)], cancelled, { "content-length": "10" }), 5),
    ).toBeNull();
    const second = vi.fn();
    const read = vi.fn();
    const chunks = Array.from({ length: 50 }, () => {
      read();
      return new Uint8Array(100);
    });
    expect(await readLimited(streamed(chunks, second), 250)).toBeNull();
    expect(second).toHaveBeenCalled();
  });
});

describe("avatars", () => {
  it("are not fetched from an origin outside the allowed list, and a user-chosen URL costs no request", async () => {
    const fetchImpl = vi.fn(pngFetch());
    const r = await rig({
      host: { fetchImpl },
    });
    rigs.push(r);
    const evil = baseSnapshot();
    r.transport.handlers!.onSession(evil);
    await r.app.settle();
    // the fixture directory points Bia at the allowed origin: one fetch, to it
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual(["https://pqp.example/api/avatars/bia"]);

    const hostile = vi.fn(pngFetch());
    const r2 = await rig({
      host: { fetchImpl: hostile, avatarOrigins: ["https://api.example"] },
    });
    rigs.push(r2);
    await r2.app.call({ type: "participants.get" });
    expect(hostile).not.toHaveBeenCalled();
  });

  it("are read with a byte limit: a huge body is cut off, not buffered", async () => {
    const cancelled = vi.fn();
    const fetchImpl = (async () =>
      streamed(
        Array.from({ length: 200 }, () => new Uint8Array(10_000)),
        cancelled,
        { "content-type": "image/png" },
      )) as typeof fetch;
    expect(await fetchAvatarDataUrl("https://pqp.example/a", fetchImpl)).toBeNull();
    expect(cancelled).toHaveBeenCalled();
    const declared = (async () =>
      new Response(new Uint8Array(10), { headers: { "content-type": "image/png", "content-length": String(APP_AVATAR_MAX_CHARS * 2) } })) as typeof fetch;
    expect(await fetchAvatarDataUrl("https://pqp.example/a", declared)).toBeNull();
  });

  it("follow a redirect only on pqp's own avatar route; any other URL may not redirect at all", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const png = (async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    await fetchAvatarDataUrl("https://api.pqp.example/api/avatars/00000000-0000-4000-8000-000000000001?v=ab12", png);
    await fetchAvatarDataUrl("https://api.pqp.example/api/connections/steam/start?next=https://evil.example", png);
    await fetchAvatarDataUrl("https://api.pqp.example/api/avatars/x/../../redirect", png);
    expect(seen.map((init) => init?.redirect)).toEqual(["follow", "error", "error"]);

    // and a response that was redirected anyway is refused when the URL was not the avatar route
    const cancelled = vi.fn();
    const bounced = (async () => {
      const r = streamed([new Uint8Array(4)], cancelled, { "content-type": "image/png" });
      Object.defineProperty(r, "redirected", { value: true });
      Object.defineProperty(r, "url", { value: "https://bucket.example/x.png" });
      return r;
    }) as unknown as typeof fetch;
    expect(await fetchAvatarDataUrl("https://api.pqp.example/somewhere", bounced)).toBeNull();
    expect(cancelled).toHaveBeenCalled();
  });

  it("let go of the body of every response they refuse", async () => {
    const cases: Array<{ status?: number; type: string; redirectedTo?: string }> = [
      { status: 404, type: "image/png" },
      { type: "image/svg+xml" },
      { type: "image/png", redirectedTo: "http://192.168.0.2/x.png" },
    ];
    for (const c of cases) {
      const cancelled = vi.fn();
      const fetchImpl = (async () => {
        const s = streamed([new Uint8Array(4)], cancelled, { "content-type": c.type });
        const r = new Response(s.body, { status: c.status ?? 200, headers: { "content-type": c.type } });
        if (c.redirectedTo) {
          Object.defineProperty(r, "redirected", { value: true });
          Object.defineProperty(r, "url", { value: c.redirectedTo });
        }
        return r;
      }) as unknown as typeof fetch;
      const url = "https://api.pqp.example/api/avatars/00000000-0000-4000-8000-000000000001";
      expect(await fetchAvatarDataUrl(url, fetchImpl), JSON.stringify(c)).toBeNull();
      expect(cancelled, JSON.stringify(c)).toHaveBeenCalled();
    }
  });
});

describe("a roster of many people", () => {
  it("fetches avatars a few at a time and stops once the roster's budget is spent", async () => {
    let live = 0;
    let peak = 0;
    let calls = 0;
    // each avatar is as large as one may be
    const big = new Uint8Array(Math.floor(((APP_AVATAR_MAX_CHARS - 30) / 4) * 3));
    const fetchImpl = (async () => {
      calls += 1;
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 2));
      live -= 1;
      return new Response(big, { headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    const many = Array.from({ length: 200 }, (_, i) => ({
      seatId: `seat-${String(i).padStart(16, "0")}`,
      userId: `u-${i}`,
      role: "player" as const,
      isHost: i === 0,
      connection: "present" as const,
    }));
    const directory = { resolve: (id: string) => ({ displayName: id, avatarUrl: `https://pqp.example/a/${id}` }) };
    const transport = new FakeTransport(baseSnapshot({ participants: many }));
    const host = new BridgeHost({
      app: baseApp(),
      transport,
      users: directory,
      locale: () => "en",
      theme: new FakeTheme(),
      fetchImpl,
      appsOrigin: "http://localhost:5175",
      avatarOrigins: ["https://pqp.example"],
    });
    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 600));
    host.detach();
    expect(peak).toBeLessThanOrEqual(6);
    expect(calls).toBeLessThan(200);
    // the budget is 4 MiB of characters: about 64 maximal avatars, plus the few in flight when it ran out
    expect(calls).toBeLessThanOrEqual(Math.ceil(APP_PARTICIPANTS_AVATAR_BUDGET_CHARS / APP_AVATAR_MAX_CHARS) + 8);
  });
});

describe("assets", () => {
  const body = new Uint8Array([10, 20, 30, 40]);
  const ref = async (url = "http://localhost:5175/pqp-eco/1.0.0/core.wasm") => ({
    name: "core.wasm",
    url,
    sha256: await sha(body),
    bytes: 4,
  });

  it("refuses an asset URL off the apps origin without a request", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchAsset(await ref("https://evil.example/core.wasm"), "http://localhost:5175", fetchImpl as never);
    expect(result).toEqual({ ok: false, reason: "origin" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await fetchAsset(await ref("not a url"), "http://localhost:5175", fetchImpl as never)).toEqual({ ok: false, reason: "origin" });
  });

  it("refuses redirects, and cuts a body that is past the declared size short", async () => {
    let init: RequestInit | undefined;
    const ok = (async (_url: string, i?: RequestInit) => {
      init = i;
      return new Response(body as BodyInit);
    }) as unknown as typeof fetch;
    expect((await fetchAsset(await ref(), "http://localhost:5175", ok)).ok).toBe(true);
    expect(init?.redirect).toBe("error");

    const cancelled = vi.fn();
    const long = (async () =>
      streamed(
        Array.from({ length: 100 }, () => new Uint8Array(1000)),
        cancelled,
      )) as typeof fetch;
    expect(await fetchAsset(await ref(), "http://localhost:5175", long)).toEqual({ ok: false, reason: "size" });
    expect(cancelled).toHaveBeenCalled();
  });

  it("lets go of an error page's body instead of leaving its stream open", async () => {
    const cancelled = vi.fn();
    const failing = (async () => {
      const r = streamed([new Uint8Array(10)], cancelled);
      return new Response(r.body, { status: 503 });
    }) as typeof fetch;
    expect(await fetchAsset(await ref(), "http://localhost:5175", failing)).toEqual({ ok: false, reason: "fetch" });
    expect(cancelled).toHaveBeenCalled();
  });

  it("gives up on a body that stops half way, and answers fetch", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      let init: RequestInit | undefined;
      const stalls = (async (_url: string, i?: RequestInit) => {
        init = i;
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              // two of the four declared bytes, then nothing ever again
              if (!sent) controller.enqueue(new Uint8Array([10, 20]));
              sent = true;
              return new Promise(() => {});
            },
            cancel: cancelled,
          }),
        );
      }) as unknown as typeof fetch;
      const pending = fetchAsset(await ref(), "http://localhost:5175", stalls);
      await vi.advanceTimersByTimeAsync(ASSET_IDLE_TIMEOUT_MS + 1);
      expect(await pending).toEqual({ ok: false, reason: "fetch" });
      expect(cancelled).toHaveBeenCalled();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on an origin that never starts answering", async () => {
    vi.useFakeTimers();
    try {
      const never = ((_url: string, i?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          i?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch;
      const pending = fetchAsset(await ref(), "http://localhost:5175", never);
      await vi.advanceTimersByTimeAsync(ASSET_HEADERS_TIMEOUT_MS + 1);
      expect(await pending).toEqual({ ok: false, reason: "fetch" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches one asset once however many requests arrive while it runs", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      if (!String(url).endsWith("core.wasm")) return new Response("no", { status: 404 });
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(body as BodyInit);
    }) as unknown as typeof fetch;
    const r = await rig({ app: { assets: [await ref()] }, host: { fetchImpl } });
    rigs.push(r);
    const answers = await Promise.all(
      [1, 2, 3, 4].map(() => r.app.call({ type: "assets.get", name: "core.wasm" })),
    );
    expect(answers.every((a) => a.ok === true)).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("a join that outlives the frame", () => {
  it("releases the seat it gets after the host was detached", async () => {
    const transport = new FakeTransport();
    let release!: () => void;
    transport.join = () =>
      new Promise((resolve) => {
        release = () => resolve(transport.snapshot);
      });
    const host = new BridgeHost({
      app: baseApp(),
      transport,
      users,
      locale: () => "en",
      theme: new FakeTheme(),
      appsOrigin: "http://localhost:5175",
    });
    const started = host.start();
    host.detach();
    host.leave(); // nothing to leave yet: no snapshot
    expect(transport.left).toBe(0);
    release();
    await started;
    expect(transport.left).toBe(1);
  });

  it("still rejects a refused join as before", async () => {
    const transport = new FakeTransport();
    transport.joinError = new AppTransportError("full");
    const host = new BridgeHost({
      app: baseApp(),
      transport,
      users,
      locale: () => "en",
      appsOrigin: "http://localhost:5175",
    });
    await expect(host.start()).rejects.toMatchObject({ code: "full" });
    host.detach();
  });
});
