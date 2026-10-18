import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  resetInFlightReads,
  setAuthTokenProvider,
} from "./api";

/**
 * One page load asked for seven switch endpoints twice, at the same millisecond
 * (`/api/onboarding/config` from two modules, `/api/fun/config` from two,
 * `/api/push/config`, `/api/voice/config`, ...), each with its own CORS
 * preflight. Callers that ask while one is already out now share it. What this
 * file pins is the other half: nothing is REMEMBERED, so the operator's next
 * flag flip is seen on the very next read, and nothing that a mutation can
 * change is ever shared.
 */

let fetchSpy: ReturnType<typeof vi.fn>;
let pending: Array<() => void>;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that answers only when the test says so, so calls can overlap. */
function deferredFetch(body: () => unknown, status = 200) {
  fetchSpy = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push(() => resolve(jsonResponse(body(), status)));
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
}

const settleAll = async () => {
  for (const release of pending.splice(0)) {
    release();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  pending = [];
  resetInFlightReads();
  setAuthTokenProvider(async () => "token");
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch shares a switch read that is already in flight", () => {
  it("sends one request for two callers asking at the same moment, and both get the answer", async () => {
    deferredFetch(() => ({ inviteMoment: true }));
    const a = apiFetch<{ inviteMoment: boolean }>("/api/onboarding/config");
    const b = apiFetch<{ inviteMoment: boolean }>("/api/onboarding/config");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await settleAll();
    expect(await a).toEqual({ inviteMoment: true });
    expect(await b).toEqual({ inviteMoment: true });
  });

  it("remembers nothing: the next ask after it settled is a real request", async () => {
    let flag = false;
    deferredFetch(() => ({ nudge: flag }));
    const first = apiFetch<{ nudge: boolean }>("/api/fun/config");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settleAll();
    expect(await first).toEqual({ nudge: false });

    // The operator flips the flag; the very next read must see it.
    flag = true;
    const second = apiFetch<{ nudge: boolean }>("/api/fun/config");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await settleAll();
    expect(await second).toEqual({ nudge: true });
  });

  it("hands each caller its own copy, so one cannot corrupt another's answer", async () => {
    deferredFetch(() => ({ list: [1, 2] }));
    const a = apiFetch<{ list: number[] }>("/api/push/config");
    const b = apiFetch<{ list: number[] }>("/api/push/config");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settleAll();
    const [first, second] = [await a, await b];
    first.list.push(3);
    expect(second.list).toEqual([1, 2]);
  });

  it("shares a failure, and the next ask after it tries again", async () => {
    deferredFetch(() => ({ error: "database_unavailable" }), 503);
    const a = apiFetch("/api/voice/config").catch((error) => error);
    const b = apiFetch("/api/voice/config").catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await settleAll();
    expect((await a as { status: number }).status).toBe(503);
    expect((await b as { status: number }).status).toBe(503);

    deferredFetch(() => ({ ok: true }));
    const retry = apiFetch("/api/voice/config");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await settleAll();
    expect(await retry).toEqual({ ok: true });
  });

  it("keeps a per-server variant (a query) a read of its own", async () => {
    deferredFetch(() => ({}));
    void apiFetch("/api/live-hls/config?serverId=a");
    void apiFetch("/api/live-hls/config?serverId=b");
    void apiFetch("/api/live-hls/config");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await settleAll();
  });

  it("never shares anything a mutation can change: lists, unread, messages, members", async () => {
    deferredFetch(() => ({}));
    for (const path of [
      "/api/servers",
      "/api/community-home/unread",
      "/api/channels/c1/messages",
      "/api/servers/s1/members",
      "/api/friends",
    ]) {
      void apiFetch(path);
      void apiFetch(path);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(10);
    await settleAll();
  });

  it("never shares a read that carries any option of its own (headers, a cache mode)", async () => {
    deferredFetch(() => ({}));
    void apiFetch("/api/fun/config", { headers: { "X-Probe": "1" } });
    void apiFetch("/api/fun/config", { cache: "no-store" });
    void apiFetch("/api/fun/config");
    void apiFetch("/api/fun/config", { method: "GET" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The two plain ones (no options, and an explicit GET) share one request.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await settleAll();
  });

  it("never shares a write, or a read whose caller can cancel it", async () => {
    deferredFetch(() => ({}));
    void apiFetch("/api/gifs/config", { method: "POST", body: "{}" });
    void apiFetch("/api/gifs/config", { method: "POST", body: "{}" });
    const controller = new AbortController();
    void apiFetch("/api/gifs/config", { signal: controller.signal });
    void apiFetch("/api/gifs/config", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    await settleAll();
  });
});
