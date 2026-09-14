import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hlsEdgeChannelRevocationKey,
  hlsEdgeRevocationKey,
  resetHlsEdgeRevocationRetryDelaysForTests,
  setHlsEdgeRevocationRetryDelaysForTests,
  writeHlsEdgeChannelRevocation,
  writeHlsEdgeRevocation,
  writeHlsEdgeRevocationForScope,
} from "./hls-edge-revocation.js";

/**
 * The API-side half of the edge Worker's KV denylist: this is what actually
 * writes the keys `PartyPassRevocationGate` (Worker side,
 * `tools/hls-edge/src/party-pass-revocation.js`) reads. What has to be
 * right: the key shapes match exactly, a write never regresses an already-
 * recorded newer revocation (monotonic), a failed write retries through a
 * bounded in-process queue rather than being silently lost, KV requests
 * never pile up unbounded, response bodies are always drained, and the
 * whole thing stays a no-op (not even a log line) when the three
 * `HLS_EDGE_KV_*` env vars are not all set -- which is every deployment
 * that has not provisioned the edge KV namespace.
 */
const ACCOUNT_ID = "acct-123";
const NAMESPACE_ID = "ns-456";
const API_TOKEN = "cf-token-789";

function setKvEnv(): void {
  process.env.HLS_EDGE_KV_ACCOUNT_ID = ACCOUNT_ID;
  process.env.HLS_EDGE_KV_NAMESPACE_ID = NAMESPACE_ID;
  process.env.HLS_EDGE_KV_API_TOKEN = API_TOKEN;
}

function clearKvEnv(): void {
  delete process.env.HLS_EDGE_KV_ACCOUNT_ID;
  delete process.env.HLS_EDGE_KV_NAMESPACE_ID;
  delete process.env.HLS_EDGE_KV_API_TOKEN;
}

/** A fake KV REST backend: GET returns whatever was last PUT (or 404), matching real semantics closely enough to test read-modify-write. */
function fakeKvBackend(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const urlStr = String(url);
    calls.push({ method, url: urlStr });
    const key = decodeURIComponent(urlStr.split("/values/")[1]!.split("?")[0]!);
    if (method === "GET") {
      const value = store.get(key);
      if (value === undefined) {
        return new Response("", { status: 404 });
      }
      return new Response(value, { status: 200 });
    }
    if (method === "PUT") {
      store.set(key, String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { fetchImpl, store, calls };
}

describe("hlsEdgeRevocationKey / hlsEdgeChannelRevocationKey", () => {
  it("matches the Worker gate's own per-viewer key shape: userId:channelId", () => {
    expect(hlsEdgeRevocationKey("user-1", "chan-1")).toBe("user-1:chan-1");
  });

  it("matches the Worker gate's own channel-wide key shape: channel:<channelId>", () => {
    expect(hlsEdgeChannelRevocationKey("chan-1")).toBe("channel:chan-1");
  });
});

describe("writeHlsEdgeRevocation", () => {
  beforeEach(() => {
    setHlsEdgeRevocationRetryDelaysForTests([1, 1, 1]);
  });

  afterEach(() => {
    clearKvEnv();
    resetHlsEdgeRevocationRetryDelaysForTests();
  });

  it("is a no-op with no config: no fetch call at all", async () => {
    clearKvEnv();
    const fetchImpl = vi.fn();
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is a no-op with only some of the three env vars set", async () => {
    process.env.HLS_EDGE_KV_ACCOUNT_ID = ACCOUNT_ID;
    process.env.HLS_EDGE_KV_NAMESPACE_ID = NAMESPACE_ID;
    delete process.env.HLS_EDGE_KV_API_TOKEN;
    const fetchImpl = vi.fn();
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads then PUTs the exact key, TTL and bearer token the Worker's KV namespace expects", async () => {
    setKvEnv();
    const { fetchImpl, store } = fakeKvBackend();
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_726_000_000_000, fetchImpl);
    expect(store.get("user-1:chan-1")).toBe("1726000000000");
    const putCall = fetchImpl.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT")!;
    const [url, init] = putCall;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/user-1%3Achan-1?expiration_ttl=21600`,
    );
    expect((init as RequestInit).method).toBe("PUT");
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_TOKEN}`,
    );
    expect((init as RequestInit).body).toBe("1726000000000");
  });

  it("the TTL is the party pass's hard ceiling (6h = 21600s), not whatever LIVE_HLS_PARTY_PASS_TTL_MS currently says", async () => {
    setKvEnv();
    process.env.LIVE_HLS_PARTY_PASS_TTL_MS = "60000"; // 1 minute -- must not shrink the KV TTL
    const { fetchImpl } = fakeKvBackend();
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
    const putCall = fetchImpl.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT")!;
    expect(String(putCall[0])).toContain("expiration_ttl=21600");
    delete process.env.LIVE_HLS_PARTY_PASS_TTL_MS;
  });

  describe("monotonic writes", () => {
    it("writes a newer timestamp over an older recorded one", async () => {
      setKvEnv();
      const { fetchImpl, store } = fakeKvBackend({ "user-1:chan-1": "1000" });
      await writeHlsEdgeRevocation("user-1", "chan-1", 2_000, fetchImpl);
      expect(store.get("user-1:chan-1")).toBe("2000");
    });

    it("does not regress an already-newer recorded timestamp -- a late-arriving older write loses", async () => {
      setKvEnv();
      const { fetchImpl, store, calls } = fakeKvBackend({ "user-1:chan-1": "5000" });
      await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
      expect(store.get("user-1:chan-1")).toBe("5000");
      // Read-only: no PUT was even attempted once the GET showed a newer value.
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    });

    it("treats an equal timestamp as already-recorded (no write, no failure)", async () => {
      setKvEnv();
      const { fetchImpl, calls } = fakeKvBackend({ "user-1:chan-1": "5000" });
      await writeHlsEdgeRevocation("user-1", "chan-1", 5_000, fetchImpl);
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    });

    it("writes plainly when nothing is recorded yet (a 404 GET)", async () => {
      setKvEnv();
      const { fetchImpl, store } = fakeKvBackend();
      await writeHlsEdgeRevocation("user-1", "chan-1", 4_000, fetchImpl);
      expect(store.get("user-1:chan-1")).toBe("4000");
    });
  });

  describe("retry on failure", () => {
    it("retries after a network error and succeeds on a later attempt", async () => {
      setKvEnv();
      let attempt = 0;
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          return new Response("", { status: 404 });
        }
        attempt += 1;
        if (attempt < 2) {
          throw new Error("network down");
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
      expect(attempt).toBe(2);
    });

    it("gives up after exhausting retries and logs once with the attempt count", async () => {
      setKvEnv();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          return new Response("", { status: 404 });
        }
        throw new Error("still down");
      });
      await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
      const failureLine = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("voice.hlsEdgeRevocationWriteFailed"));
      expect(failureLine).toContain("attempts=4"); // first try + 3 retries
      logSpy.mockRestore();
    });

    it("never throws, on a network error or a non-2xx response, even after exhausting retries", async () => {
      setKvEnv();
      const networkFail = vi.fn(async () => {
        throw new Error("network down");
      });
      await expect(
        writeHlsEdgeRevocation("user-1", "chan-1", 1_000, networkFail),
      ).resolves.toBeUndefined();

      const rejected = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? new Response("", { status: 404 })
          : new Response("forbidden", { status: 403 }),
      );
      await expect(
        writeHlsEdgeRevocation("user-1", "chan-1", 1_000, rejected),
      ).resolves.toBeUndefined();
    });
  });

  describe("bounded concurrency", () => {
    it("never has more than a small number of KV requests in flight at once", async () => {
      setKvEnv();
      let inFlight = 0;
      let maxInFlight = 0;
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if ((init?.method ?? "GET") === "GET") {
          return new Response("", { status: 404 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writeHlsEdgeRevocation(`user-${i}`, "chan-1", 1_000, fetchImpl),
        ),
      );
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(fetchImpl).toHaveBeenCalledTimes(40); // 20 GETs + 20 PUTs
    });
  });
});

describe("writeHlsEdgeChannelRevocation", () => {
  afterEach(() => {
    clearKvEnv();
  });

  it("writes the channel-wide key, not a per-viewer one", async () => {
    setKvEnv();
    const { fetchImpl, store } = fakeKvBackend();
    await writeHlsEdgeChannelRevocation("chan-1", 3_000, fetchImpl);
    expect(store.get("channel:chan-1")).toBe("3000");
    expect(store.has("chan-1")).toBe(false);
  });
});

describe("writeHlsEdgeRevocationForScope", () => {
  beforeEach(() => {
    setKvEnv();
  });
  afterEach(() => {
    clearKvEnv();
  });

  it("writes one key per named user", async () => {
    const { fetchImpl, store } = fakeKvBackend();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      writeHlsEdgeRevocationForScope("chan-1", ["alice", "bob"], 1_000);
      // Fire-and-forget: give the microtask/timer queue a couple of turns.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.get("alice:chan-1")).toBe("1000");
      expect(store.get("bob:chan-1")).toBe("1000");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("writes nothing for an unscoped (everyone) revocation", async () => {
    const fetchImpl = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      writeHlsEdgeRevocationForScope("chan-1", undefined, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
