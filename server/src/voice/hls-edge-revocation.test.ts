import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hlsEdgeChannelRevocationKey,
  hlsEdgeRevocationKey,
  hlsEdgeRevocationPendingCountForTests,
  resetHlsEdgeRevocationRetryDelaysForTests,
  setHlsEdgeRevocationRetryDelaysForTests,
  writeHlsEdgeChannelRevocation,
  writeHlsEdgeRevocation,
  writeHlsEdgeRevocationAt,
  writeHlsEdgeRevocationForScope,
} from "./hls-edge-revocation.js";

/**
 * The API-side half of the edge Worker's KV denylist: this is what actually
 * writes the append-only keys `PartyPassRevocationGate` (Worker side,
 * `tools/hls-edge/src/party-pass-revocation.js`) lists back. What has to be
 * right: the key shapes match exactly, every write is a plain unconditional
 * PUT (no read first -- that read-before-write was the bug Farol caught,
 * see the module doc comment), two concurrent writers for the same
 * (userId, channelId) both survive regardless of which PUT lands first, a
 * failed write retries through a bounded queue rather than being silently
 * lost, the total number of in-flight deliveries is bounded (not just the
 * KV request concurrency), response bodies are always drained, and the
 * whole thing stays a no-op (not even a log line) when the three
 * `HLS_EDGE_KV_*` env vars are not all set.
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

/** A fake KV REST backend: PUT stores under the key, GET/LIST are not used by the write path any more but are modeled for completeness. */
function fakeKvBackend() {
  const store = new Map<string, string>();
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const urlStr = String(url);
    const key = decodeURIComponent(urlStr.split("/values/")[1]!.split("?")[0]!);
    if (method === "PUT") {
      store.set(key, String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { fetchImpl, store };
}

describe("hlsEdgeRevocationKey / hlsEdgeChannelRevocationKey", () => {
  it("is append-only: userId:channelId:revokedAtMs", () => {
    expect(hlsEdgeRevocationKey("user-1", "chan-1", 1_000)).toBe("user-1:chan-1:1000");
  });

  it("channel-wide key is append-only too: channel:channelId:revokedAtMs", () => {
    expect(hlsEdgeChannelRevocationKey("chan-1", 2_000)).toBe("channel:chan-1:2000");
  });

  it("two revocations of the same (userId, channelId) at different times get two DIFFERENT keys -- the whole point", () => {
    expect(hlsEdgeRevocationKey("user-1", "chan-1", 1_000)).not.toBe(
      hlsEdgeRevocationKey("user-1", "chan-1", 2_000),
    );
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

  it("PUTs the exact key, TTL and bearer token the Worker's KV namespace expects -- no GET first", async () => {
    setKvEnv();
    const { fetchImpl, store } = fakeKvBackend();
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_726_000_000_000, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // one PUT, no read-before-write
    expect(store.get("user-1:chan-1:1726000000000")).toBe("1726000000000");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/user-1%3Achan-1%3A1726000000000?expiration_ttl=21600`,
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
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("expiration_ttl=21600");
    delete process.env.LIVE_HLS_PARTY_PASS_TTL_MS;
  });

  describe("append-only under concurrent writers", () => {
    it("two racing writes for the same (userId, channelId) BOTH survive, regardless of which PUT lands first", async () => {
      setKvEnv();
      const { store } = fakeKvBackend();
      // Simulate network reordering: the OLDER write's PUT is issued but
      // resolves AFTER the NEWER write's PUT already landed -- the exact
      // interleaving Farol's finding described. With one mutable key and a
      // read-then-write, the older write could clobber the newer one; with
      // append-only keys there is nothing to clobber.
      let resolveOlderPut!: () => void;
      const olderPutGate = new Promise<void>((resolve) => {
        resolveOlderPut = resolve;
      });
      const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const key = decodeURIComponent(String(url).split("/values/")[1]!.split("?")[0]!);
        if (key.includes(":1000")) {
          // the OLDER write -- held open until the newer one below finishes
          await olderPutGate;
        }
        store.set(key, String(init?.body));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      const older = writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
      const newer = writeHlsEdgeRevocation("user-1", "chan-1", 2_000, fetchImpl);
      await newer; // the newer write's PUT lands first
      resolveOlderPut(); // now let the older write's PUT land
      await older;
      // BOTH keys exist -- the Worker's gate lists the prefix and takes the
      // max, so this is correct regardless of arrival order.
      expect(store.get("user-1:chan-1:1000")).toBe("1000");
      expect(store.get("user-1:chan-1:2000")).toBe("2000");
    });

    it("an in-memory fake with interleaved concurrent writers never loses a key", async () => {
      setKvEnv();
      const { store, fetchImpl } = fakeKvBackend();
      // 20 concurrent evictions for the same (userId, channelId), all
      // different timestamps, fired without awaiting each other -- the
      // shape a burst of moderation actions or a bus-replicated eviction
      // storm would actually produce.
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writeHlsEdgeRevocation("user-1", "chan-1", 1_000 + i, fetchImpl),
        ),
      );
      for (let i = 0; i < 20; i++) {
        expect(store.get(`user-1:chan-1:${1_000 + i}`)).toBe(String(1_000 + i));
      }
    });
  });

  describe("retry on failure", () => {
    it("retries after a network error and succeeds on a later attempt, then the SAME key (idempotent PUT)", async () => {
      setKvEnv();
      let attempt = 0;
      let putKey: string | undefined;
      const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        attempt += 1;
        putKey = decodeURIComponent(String(url).split("/values/")[1]!.split("?")[0]!);
        if (attempt < 2) {
          throw new Error("network down");
        }
        expect((init as RequestInit).body).toBe("1000"); // same value every attempt
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
      expect(attempt).toBe(2);
      expect(putKey).toBe("user-1:chan-1:1000");
    });

    it("gives up after exhausting retries and logs once with the attempt count", async () => {
      setKvEnv();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchImpl = vi.fn(async () => {
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

      const rejected = vi.fn(async () => new Response("forbidden", { status: 403 }));
      await expect(
        writeHlsEdgeRevocation("user-1", "chan-1", 1_000, rejected),
      ).resolves.toBeUndefined();
    });
  });

  describe("bounded fan-out", () => {
    it("never has more than a small number of KV requests in flight at once", async () => {
      setKvEnv();
      let inFlight = 0;
      let maxInFlight = 0;
      const fetchImpl = vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writeHlsEdgeRevocation(`user-${i}`, "chan-1", 1_000, fetchImpl),
        ),
      );
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(fetchImpl).toHaveBeenCalledTimes(20); // one PUT per write, no GET
    });

    it("drops a new delivery and logs once the pending-delivery bound is reached, without throwing", async () => {
      setKvEnv();
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      // Hold every PUT open forever so nothing ever settles and frees a slot.
      let release!: () => void;
      const neverSettles = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchImpl = vi.fn(async () => {
        await neverSettles;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });
      // Fill the bound directly through the exported hook rather than
      // 1,000 real writes -- exercises the same guard cheaply.
      const fills = Array.from({ length: 1_000 }, (_, i) =>
        writeHlsEdgeRevocationAt(`fill-${i}`, 1_000, fetchImpl),
      );
      // Give them a turn to register in the pending map.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hlsEdgeRevocationPendingCountForTests()).toBe(1_000);

      const overflowFetch = vi.fn();
      await writeHlsEdgeRevocationAt("overflow-key", 1_000, overflowFetch);
      expect(overflowFetch).not.toHaveBeenCalled();
      const overflowLine = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes("voice.hlsEdgeRevocationQueueFull"));
      expect(overflowLine).toBeTruthy();

      release();
      await Promise.all(fills);
      logSpy.mockRestore();
    });
  });
});

describe("writeHlsEdgeChannelRevocation", () => {
  afterEach(() => {
    clearKvEnv();
  });

  it("writes the channel-wide append-only key, not a per-viewer one", async () => {
    setKvEnv();
    const { fetchImpl, store } = fakeKvBackend();
    await writeHlsEdgeChannelRevocation("chan-1", 3_000, fetchImpl);
    expect(store.get("channel:chan-1:3000")).toBe("3000");
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
      expect(store.get("alice:chan-1:1000")).toBe("1000");
      expect(store.get("bob:chan-1:1000")).toBe("1000");
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
