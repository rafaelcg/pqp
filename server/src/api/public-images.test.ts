import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The public pictures a link unfurler probes, over HTTP against a real
 * Postgres: an uploaded avatar, a profile banner, a server's icon, banner and
 * featured image, and the public profile read.
 *
 * What is pinned, in the order of the risk:
 *
 *  - A PLAIN GET IS STILL THE REDIRECT. These are the highest-volume image
 *    routes in the app, and streaming each through the API is the egress bill
 *    the presigned design exists to avoid. Nothing about the browser path moved.
 *  - A HEAD IS ANSWERED, NOT 401. Unfurlers probe an address with HEAD and read
 *    a 401 as "no image". HEAD is the ranged-less GET answer without the body:
 *    200, a type, a length, an ETag, `Accept-Ranges`.
 *  - A GET WITH A RANGE IS SERVED: 206 with the exact bytes, 416 past the end,
 *    304 for a matching `If-None-Match` with no storage call, and a redirect
 *    (as before) for what is over the size cap or not an inert image.
 *  - EVERY REFUSAL IS THE ONE 404, whichever method asked.
 *  - THE PROFILE READ answers HEAD with the headers its GET carries, including
 *    `Content-Length`, and a garbage `Authorization` header does not veto it.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => null,
  resolveAuthSession: async () => null,
  verifyAuthHeader: async () => null,
}));

/** A bucket in memory; `calls` counts what the real one would be asked. */
const store = new Map<string, { bytes: Uint8Array; type: string }>();
const calls = { head: 0, prefix: 0, open: 0 };

vi.mock("../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/s3.js")>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    presignGet: (key: string) => `https://storage.test/get/${key}?sig=abc`,
    headObject: async (key: string) => {
      calls.head += 1;
      const object = store.get(key);
      return object
        ? { contentLength: object.bytes.length, contentType: object.type }
        : null;
    },
    getObjectPrefix: async (key: string, length: number) => {
      calls.prefix += 1;
      return store.get(key)?.bytes.subarray(0, length) ?? null;
    },
    openObject: async (key: string, range?: { start: number; end: number }) => {
      calls.open += 1;
      const object = store.get(key);
      if (!object) {
        return null;
      }
      const slice = range
        ? object.bytes.subarray(range.start, range.end + 1)
        : object.bytes;
      return new Response(new Uint8Array(slice), { status: range ? 206 : 200 });
    },
  };
});

/** A PNG header claiming 256x256 and `total` bytes in all, distinct per position. */
function pngBytes(total = 4096): Uint8Array {
  const bytes = new Uint8Array(total);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 256);
  view.setUint32(20, 256);
  for (let i = 24; i < total; i += 1) {
    bytes[i] = (i * 31) % 251;
  }
  return bytes;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer } = await import("../services/servers.js");
const { claimHandle, resetProfileFeatureCache } = await import("../services/profiles.js");
const { resetCoverInfoCache } = await import("../services/community-home-cover-info.js");

let httpServer: Server;
let baseUrl: string;

interface Wire {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/** Any method, no redirect followed, the body as bytes. The default `Authorization` is none. */
async function raw(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<Wire> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    redirect: "manual",
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** The headers a HEAD must share with the GET it stands for. */
const SAME_ON_HEAD = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "accept-ranges",
  "content-range",
  "location",
  "access-control-allow-origin",
  "x-content-type-options",
  "cross-origin-resource-policy",
];

describeDb("public pictures and the profile read: HEAD and Range", () => {
  const png = pngBytes();
  let alice: { id: string };
  let serverId: string;

  /** One case per picture route: how to reach it and where its key lives. */
  const cases = () => [
    {
      label: "avatar",
      path: `/api/avatars/${alice.id}`,
      keyFor: `avatars/${alice.id}/one.png`,
      set: (key: string) =>
        getPool().query(`UPDATE users SET avatar_key = $2 WHERE id = $1`, [alice.id, key]),
    },
    {
      label: "profile banner",
      path: `/api/users/${alice.id}/banner`,
      keyFor: `banners/${alice.id}/one.png`,
      set: (key: string) =>
        getPool().query(`UPDATE users SET banner_key = $2 WHERE id = $1`, [alice.id, key]),
    },
    ...(
      [
        ["icon", "icon_key"],
        ["banner", "banner_key"],
        ["featured", "community_featured_key"],
      ] as const
    ).map(([kind, column]) => ({
      label: `server ${kind}`,
      path: `/api/servers/${serverId}/${kind}`,
      keyFor: `server-images/${serverId}/${kind}/one.png`,
      set: (key: string) =>
        getPool().query(`UPDATE servers SET ${column} = $2 WHERE id = $1`, [serverId, key]),
    })),
  ];

  beforeAll(async () => {
    await initDb();
    httpServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    resetApiRateLimits();
    resetCoverInfoCache();
    resetProfileFeatureCache();
    store.clear();
    calls.head = 0;
    calls.prefix = 0;
    calls.open = 0;
    alice = await upsertUser({ clerkId: "clerk_img_alice", displayName: "Alice", avatarUrl: null });
    serverId = (await createChatServer("Galera", alice.id)).server.id;
  });

  it("a plain GET is still the redirect, and a HEAD is not a 401", async () => {
    for (const one of cases()) {
      store.set(one.keyFor, { bytes: png, type: "image/png" });
      await one.set(one.keyFor);

      const got = await raw(one.path);
      expect(got.status, one.label).toBe(302);
      expect(got.headers.get("location"), one.label).toBe(
        `https://storage.test/get/${one.keyFor}?sig=abc`,
      );
      expect(got.headers.get("cache-control")).toBe("public, max-age=300");

      const head = await raw(one.path, "HEAD");
      expect(head.status, `${one.label} HEAD`).toBe(200);
      expect(head.headers.get("content-type")).toBe("image/png");
      expect(head.headers.get("content-length")).toBe(String(png.length));
      expect(head.headers.get("accept-ranges")).toBe("bytes");
      expect(head.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
      expect(head.headers.get("cache-control")).toBe("public, max-age=300");
      expect(head.headers.get("access-control-allow-origin")).toBe("*");
      expect(head.bytes.length).toBe(0);
    }
  });

  it("a ranged GET is served: 206 with exactly those bytes, 416 past the end", async () => {
    for (const one of cases()) {
      store.set(one.keyFor, { bytes: png, type: "image/png" });
      await one.set(one.keyFor);

      const first = await raw(one.path, "GET", { Range: "bytes=0-99" });
      expect(first.status, one.label).toBe(206);
      expect(first.headers.get("content-range")).toBe(`bytes 0-99/${png.length}`);
      expect(first.headers.get("content-length")).toBe("100");
      expect(Buffer.from(first.bytes).equals(Buffer.from(png.subarray(0, 100)))).toBe(true);

      const tail = await raw(one.path, "GET", { Range: "bytes=-50" });
      expect(tail.status).toBe(206);
      expect(Buffer.from(tail.bytes).equals(Buffer.from(png.subarray(png.length - 50)))).toBe(true);

      const past = await raw(one.path, "GET", { Range: `bytes=${png.length}-` });
      expect(past.status).toBe(416);
      expect(past.headers.get("content-range")).toBe(`bytes */${png.length}`);

      // A HEAD with a Range is the same answer without the body.
      const head = await raw(one.path, "HEAD", { Range: "bytes=0-99" });
      expect(head.status).toBe(206);
      expect(head.headers.get("content-range")).toBe(`bytes 0-99/${png.length}`);
      expect(head.bytes.length).toBe(0);
    }
  });

  it("a matching If-None-Match is a 304 that costs the bucket nothing", async () => {
    const [avatar] = cases();
    store.set(avatar!.keyFor, { bytes: png, type: "image/png" });
    await avatar!.set(avatar!.keyFor);
    const etag = (await raw(avatar!.path, "HEAD")).headers.get("etag")!;
    const before = { ...calls };
    const res = await raw(avatar!.path, "HEAD", { "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(calls).toEqual(before);
    // A plain GET is not asked about a validator: nothing it ever returned carries one.
    expect((await raw(avatar!.path, "GET", { "If-None-Match": etag })).status).toBe(302);
  });

  it("over the size cap, or not an inert image, HEAD and Range still redirect as before", async () => {
    const [avatar] = cases();
    await avatar!.set(avatar!.keyFor);
    store.set(avatar!.keyFor, { bytes: pngBytes(5 * 1024 * 1024 + 1), type: "image/png" });
    for (const method of ["HEAD", "GET"]) {
      const res = await raw(avatar!.path, method, { Range: "bytes=0-9" });
      expect(res.status, `${method} over the cap`).toBe(302);
      expect(res.headers.get("location")).toBe(`https://storage.test/get/${avatar!.keyFor}?sig=abc`);
    }
    resetCoverInfoCache();
    store.set(avatar!.keyFor, {
      bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      type: "image/svg+xml",
    });
    expect((await raw(avatar!.path, "HEAD")).status).toBe(302);
    expect((await raw(avatar!.path, "GET", { Range: "bytes=0-9" })).status).toBe(302);
    expect(calls.open).toBe(0);
  });

  it("every refusal is the one 404, whatever the method", async () => {
    const [avatar, banner] = cases();
    const unknown = "99999999-9999-4999-8999-999999999999";
    const paths = [
      avatar!.path, // a user with no uploaded avatar
      banner!.path,
      `/api/avatars/${unknown}`,
      `/api/users/${unknown}/banner`,
      `/api/servers/${unknown}/icon`,
      `/api/servers/${serverId}/icon`, // a server with no icon
    ];
    for (const path of paths) {
      const bodies = new Set<string>();
      for (const [method, headers] of [
        ["GET", {}],
        ["HEAD", {}],
        ["GET", { Range: "bytes=0-9" }],
      ] as const) {
        const res = await raw(path, method, { ...headers });
        expect(res.status, `${method} ${path}`).toBe(404);
        bodies.add(Buffer.from(res.bytes).toString());
      }
      // The GETs share one body (a HEAD has none).
      expect([...bodies].filter(Boolean)).toHaveLength(1);
    }
    // A key the bucket does not hold is the same 404 for a HEAD.
    await avatar!.set(avatar!.keyFor);
    expect((await raw(avatar!.path, "HEAD")).status).toBe(404);
  });

  it("the public profile answers HEAD with the headers its GET carries", async () => {
    await claimHandle(alice.id, "alicia");
    const path = "/api/public/profiles/alicia";
    const got = await raw(path);
    expect(got.status).toBe(200);
    expect(JSON.parse(Buffer.from(got.bytes).toString()).profile.handle).toBe("alicia");
    // A garbage Authorization header does not veto it, and HEAD carries the GET's length.
    for (const headers of [{}, { Authorization: "Bearer not-a-real-token" }] as Array<Record<string, string>>) {
      const head = await raw(path, "HEAD", headers);
      expect(head.status).toBe(200);
      for (const name of SAME_ON_HEAD) {
        expect(head.headers.get(name), name).toBe(got.headers.get(name));
      }
      expect(head.headers.get("content-length")).toBe(String(got.bytes.length));
      expect(head.bytes.length).toBe(0);
    }
    const missing = await raw("/api/public/profiles/ninguem", "HEAD");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });
});
