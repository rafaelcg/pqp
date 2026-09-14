import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hlsEdgeRevocationKey,
  writeHlsEdgeRevocation,
  writeHlsEdgeRevocationForScope,
} from "./hls-edge-revocation.js";

/**
 * The API-side half of the edge Worker's KV denylist: this is what actually
 * writes the key `PartyPassRevocationGate` (Worker side,
 * `tools/hls-edge/src/party-pass-revocation.js`) reads. What has to be
 * right: the key shape matches exactly, the write never blocks or throws
 * back into the eviction path that calls it, and it stays a no-op (not even
 * a log line) when the three `HLS_EDGE_KV_*` env vars are not all set --
 * which is every deployment that has not provisioned the edge KV namespace.
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

describe("hlsEdgeRevocationKey", () => {
  it("matches the Worker gate's own key shape: userId:channelId", () => {
    expect(hlsEdgeRevocationKey("user-1", "chan-1")).toBe("user-1:chan-1");
  });
});

describe("writeHlsEdgeRevocation", () => {
  afterEach(() => {
    clearKvEnv();
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

  it("PUTs the exact key, TTL and bearer token the Worker's KV namespace expects", async () => {
    setKvEnv();
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_726_000_000_000, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}/values/user-1%3Achan-1?expiration_ttl=21600`,
    );
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(init?.body).toBe("1726000000000");
  });

  it("the TTL is the party pass's hard ceiling (6h = 21600s), not whatever LIVE_HLS_PARTY_PASS_TTL_MS currently says", async () => {
    setKvEnv();
    process.env.LIVE_HLS_PARTY_PASS_TTL_MS = "60000"; // 1 minute -- must not shrink the KV TTL
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    await writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("expiration_ttl=21600");
    delete process.env.LIVE_HLS_PARTY_PASS_TTL_MS;
  });

  it("never throws on a network error", async () => {
    setKvEnv();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("never throws on a non-2xx response", async () => {
    setKvEnv();
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      writeHlsEdgeRevocation("user-1", "chan-1", 1_000, fetchImpl),
    ).resolves.toBeUndefined();
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
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      writeHlsEdgeRevocationForScope("chan-1", ["alice", "bob"], 1_000);
      // Fire-and-forget: give the microtask queue a turn.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toHaveLength(2);
      expect(calls.some((u) => u.includes("alice%3Achan-1"))).toBe(true);
      expect(calls.some((u) => u.includes("bob%3Achan-1"))).toBe(true);
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
