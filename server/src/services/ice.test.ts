import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ICE provider chain, pinned as an ORDER.
 *
 * This file exists because the order was wrong in production and nothing
 * noticed. Static TURN_* returned early, so Cloudflare credentials sat
 * deployed on the API and were never handed to a single client, and a static
 * relay going down took cross-network voice with it because the code never
 * asked whether anything else was available.
 *
 * Both of those are invisible to a type checker and to every other test in
 * this repo: the function returns a valid, well-formed ICE list in each case.
 * The only thing that distinguishes right from wrong here is WHICH relay comes
 * back, so that is what every test below asserts.
 *
 * `getIceServers` caches the dynamic result at module scope for an hour, so
 * each test re-imports the module to get a cold cache. Sharing one import
 * would let the first test's success mask the rest.
 */

const TURN_ENV = [
  "TURN_URL",
  "TURN_USERNAME",
  "TURN_CREDENTIAL",
  "VITE_TURN_URL",
  "VITE_TURN_USERNAME",
  "VITE_TURN_CREDENTIAL",
  "CLOUDFLARE_TURN_KEY_ID",
  "CLOUDFLARE_TURN_API_TOKEN",
  "METERED_API_KEY",
  "OPENRELAY_API_KEY",
  "METERED_DOMAIN",
  "METERED_APP_NAME",
  "TURN_PREFER_STATIC",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TURN_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const key of TURN_ENV) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  vi.unstubAllGlobals();
});

/** A cold import, so the module-scope hour-long cache never leaks between tests. */
async function freshGetIceServers() {
  const mod = await import("./ice.js");
  return mod.getIceServers;
}

function setStaticTurn() {
  process.env.TURN_URL = "turn:static.example.net:3478";
  process.env.TURN_USERNAME = "static-user";
  process.env.TURN_CREDENTIAL = "static-secret";
}

function setCloudflareKeys() {
  process.env.CLOUDFLARE_TURN_KEY_ID = "key-id";
  process.env.CLOUDFLARE_TURN_API_TOKEN = "api-token";
}

/**
 * What Cloudflare's generate-ice-servers endpoint answers with.
 *
 * A single OBJECT under `iceServers`, not an array. Writing this mock is what
 * exposed the parser bug: the old code typed the field as an array and tested
 * `.length`, so the real response was read as empty and discarded silently.
 * Keep this shape faithful; making it an array to suit the code would hide the
 * exact defect this file exists to prevent.
 */
function cloudflareOk() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      iceServers: {
        urls: ["turn:cloudflare.example.net:3478"],
        username: "cf-user",
        credential: "cf-secret",
      },
    }),
  })) as unknown as typeof fetch;
}

/** The array shape, which the code already assumed and must keep accepting. */
function cloudflareOkArray() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      iceServers: [
        {
          urls: ["turn:cloudflare.example.net:3478"],
          username: "cf-user",
          credential: "cf-secret",
        },
      ],
    }),
  })) as unknown as typeof fetch;
}

function urlsOf(servers: Array<{ urls: string | string[] }>): string[] {
  return servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
}

describe("getIceServers provider order", () => {
  it("prefers Cloudflare over static TURN when BOTH are configured", async () => {
    // The exact production shape, and the bug: this used to answer static.
    setStaticTurn();
    setCloudflareKeys();
    vi.stubGlobal("fetch", cloudflareOk());

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("cloudflare.example.net"))).toBe(true);
    expect(urls.some((u) => u.includes("static.example.net"))).toBe(false);
  });

  it("falls back to static TURN when Cloudflare answers with nothing usable", async () => {
    setStaticTurn();
    setCloudflareKeys();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    // The whole point of the reorder: a dynamic outage must not take voice out.
    expect(urls.some((u) => u.includes("static.example.net"))).toBe(true);
  });

  it("falls back to static TURN when the Cloudflare fetch throws", async () => {
    setStaticTurn();
    setCloudflareKeys();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("static.example.net"))).toBe(true);
  });

  it("does not pin a dynamic failure into the cache", async () => {
    // A provider that is down for one request must be retried on the next,
    // not written off for the hour the success path caches for.
    setStaticTurn();
    setCloudflareKeys();

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          throw new Error("transient");
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            iceServers: {
              urls: ["turn:cloudflare.example.net:3478"],
              username: "cf-user",
              credential: "cf-secret",
            },
          }),
        };
      }) as unknown as typeof fetch,
    );

    const getIceServers = await freshGetIceServers();

    const first = urlsOf(await getIceServers());
    expect(first.some((u) => u.includes("static.example.net"))).toBe(true);

    const second = urlsOf(await getIceServers());
    expect(second.some((u) => u.includes("cloudflare.example.net"))).toBe(true);
  });

  it("honours TURN_PREFER_STATIC as a one-command rollback", async () => {
    setStaticTurn();
    setCloudflareKeys();
    process.env.TURN_PREFER_STATIC = "true";
    const fetchSpy = cloudflareOk();
    vi.stubGlobal("fetch", fetchSpy);

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("static.example.net"))).toBe(true);
    expect(urls.some((u) => u.includes("cloudflare.example.net"))).toBe(false);
    // And it short-circuits rather than fetching and discarding.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only the exact string true flips the escape hatch", async () => {
    // A truthy-looking value must not silently restore the old behaviour.
    setStaticTurn();
    setCloudflareKeys();
    process.env.TURN_PREFER_STATIC = "1";
    vi.stubGlobal("fetch", cloudflareOk());

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("cloudflare.example.net"))).toBe(true);
  });

  it("a self-host with only static TURN makes no network call", async () => {
    // The dynamic lookups must not cost a request when their keys are absent.
    setStaticTurn();
    const fetchSpy = vi.fn(async () => {
      throw new Error("should never be called");
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("static.example.net"))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts the array shape too", async () => {
    setCloudflareKeys();
    vi.stubGlobal("fetch", cloudflareOkArray());

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("cloudflare.example.net"))).toBe(true);
  });

  it("treats a genuinely empty iceServers as a failure, not as success", async () => {
    setStaticTurn();
    setCloudflareKeys();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ iceServers: [] }),
      })) as unknown as typeof fetch,
    );

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.includes("static.example.net"))).toBe(true);
  });

  it("answers STUN only when nothing is configured", async () => {
    const getIceServers = await freshGetIceServers();
    const servers = await getIceServers();
    const urls = urlsOf(servers);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("stun:"))).toBe(true);
  });

  it("always includes STUN alongside a relay", async () => {
    // A relay-only list makes every call pay for a relay it may not need.
    setStaticTurn();
    setCloudflareKeys();
    vi.stubGlobal("fetch", cloudflareOk());

    const getIceServers = await freshGetIceServers();
    const urls = urlsOf(await getIceServers());

    expect(urls.some((u) => u.startsWith("stun:"))).toBe(true);
    expect(urls.some((u) => u.startsWith("turn:"))).toBe(true);
  });
});
