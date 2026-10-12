import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Custom emoji go through the same image scan as chat attachments and Baú
 * media, on the claim, before the row exists. The router, the permission
 * check, the reports table and Postgres are real; storage is an in-memory
 * stand-in and the scanner is the real `openai` adapter talking to a stubbed
 * `fetch` (this test's own HTTP calls to the API go to the real one).
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const stored = new Map<string, { bytes: Buffer; contentType: string }>();
const deletedKeys: string[] = [];
let copyFails = false;

vi.mock("../lib/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/s3.js")>()),
  isStorageConfigured: () => true,
  presignPut: (key: string) => `http://storage.test/put/${key}`,
  presignGet: (key: string) => `http://storage.test/get/${key}`,
  headObject: async (key: string) => {
    const object = stored.get(key);
    return object
      ? { contentLength: object.bytes.length, contentType: object.contentType }
      : null;
  },
  deleteObject: async (key: string) => {
    deletedKeys.push(key);
    stored.delete(key);
  },
  copyObject: async (from: string, to: string) => {
    const object = stored.get(from);
    if (copyFails || !object) {
      throw new Error("copy failed");
    }
    stored.set(to, { bytes: Buffer.from(object.bytes), contentType: object.contentType });
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer } = await import("../services/servers.js");
const { sweepQuarantinedServerEmoji } = await import("../services/server-emoji-scan.js");

const realFetch = globalThis.fetch;
let httpServer: Server;
let baseUrl: string;

let scanner: (() => Response | Promise<Response>) | null = null;
let scannerCalls = 0;

function scores(body: Record<string, number>): () => Response {
  return () =>
    new Response(JSON.stringify({ results: [{ category_scores: body }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function configureScanner(respond: () => Response | Promise<Response>): void {
  process.env.CONTENT_SCAN_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  scanner = respond;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function flushDiscards(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
  0x44, 0x52,
]);

const SCAN_ENV = [
  "CONTENT_SCAN_PROVIDER",
  "CONTENT_SCAN_FAIL_MODE",
  "CONTENT_SCAN_QUARANTINE_DAYS",
  "OPENAI_API_KEY",
] as const;

describeDb("server emoji image scan", () => {
  let owner: { id: string; clerk_id: string };
  let serverId: string;

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
    stored.clear();
    deletedKeys.length = 0;
    copyFails = false;
    scanner = null;
    scannerCalls = 0;
    for (const key of SCAN_ENV) {
      delete process.env[key];
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(baseUrl)) {
          return realFetch(input, init);
        }
        scannerCalls += 1;
        if (!scanner) {
          throw new Error(`unexpected outbound request to ${url}`);
        }
        return scanner();
      }),
    );
    owner = await upsertUser({ clerkId: "clerk_owner", displayName: "owner", avatarUrl: null });
    actor = owner;
    serverId = (await createChatServer("Mesa da Tues", owner.id)).server.id;
  });

  afterEach(() => {
    for (const key of SCAN_ENV) {
      delete process.env[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mint(name = "pog"): Promise<string> {
    const minted = await call<{ key: string }>("POST", `/api/servers/${serverId}/emoji/uploads`, {
      name,
      contentType: "image/png",
      byteSize: PNG.length,
    });
    expect(minted.status).toBe(201);
    stored.set(minted.body.key, { bytes: PNG, contentType: "image/png" });
    return minted.body.key;
  }

  function claim(key: string, name = "pog") {
    return call<{ error?: string; code?: string; emoji?: { id: string } }>(
      "POST",
      `/api/servers/${serverId}/emoji`,
      { key, name },
    );
  }

  async function emojiRows() {
    const result = await getPool().query<{
      id: string;
      storage_key: string;
      scan_status: string;
      scan_provider: string | null;
      scanned_at: Date | null;
    }>(`SELECT id, storage_key, scan_status, scan_provider, scanned_at FROM server_emoji`);
    return result.rows;
  }

  async function quarantineRows() {
    const result = await getPool().query<{
      id: string;
      storage_key: string;
      name: string;
      scan_labels: string[] | null;
    }>(`SELECT id, storage_key, name, scan_labels FROM server_emoji_quarantine`);
    return result.rows;
  }

  async function reports() {
    const result = await getPool().query<{
      reason: string;
      server_id: string | null;
      channel_label: string | null;
      details: string | null;
    }>(`SELECT reason, server_id, channel_label, details FROM reports`);
    return result.rows;
  }

  it("adds an emoji unscanned, without copying it, when no scanner is configured", async () => {
    const key = await mint();
    expect((await claim(key)).status).toBe(201);
    expect(scannerCalls).toBe(0);

    const [row] = await emojiRows();
    expect(row!.storage_key).toBe(key);
    expect(row!.scan_status).toBe("unscanned");
    expect(row!.scanned_at).toBeNull();
  });

  it("scans a pinned copy of a clean image and records the verdict", async () => {
    configureScanner(scores({ sexual: 0.01, "violence/graphic": 0.02 }));
    const key = await mint();
    expect((await claim(key)).status).toBe(201);
    expect(scannerCalls).toBe(1);

    const [row] = await emojiRows();
    expect(row!.scan_status).toBe("pass");
    expect(row!.scan_provider).toBe("openai");
    expect(row!.scanned_at).not.toBeNull();
    // The row points at bytes nobody can PUT to; the original is gone.
    expect(row!.storage_key).toMatch(new RegExp(`^servers/${serverId}/emoji/pinned/`));
    await flushDiscards();
    expect(deletedKeys).toContain(key);
    expect(stored.has(row!.storage_key)).toBe(true);
    expect(await reports()).toEqual([]);
  });

  it("refuses a rejected image as unverified, quarantines it, and reports it to the instance queue", async () => {
    configureScanner(scores({ sexual: 0.98, "sexual/minors": 0.97 }));
    const key = await mint();

    const claimed = await claim(key);
    expect(claimed.status).toBe(400);
    // The same answer as a failed HEAD: the uploader is not told why.
    expect(claimed.body.code).toBe("emoji_upload_unverified");

    expect(await emojiRows()).toEqual([]);
    const [held] = await quarantineRows();
    expect(held!.name).toBe("pog");
    expect(held!.scan_labels).toEqual(["csam_suspected"]);
    await flushDiscards();
    // The pinned copy is evidence and stays.
    expect(stored.has(held!.storage_key)).toBe(true);
    expect(deletedKeys).not.toContain(held!.storage_key);

    const filed = await reports();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.reason).toBe("illegal_content");
    expect(filed[0]!.server_id).toBeNull();
    expect(filed[0]!.channel_label).toBe("Emoji · Mesa da Tues");
    expect(filed[0]!.details).toContain("never added");
  });

  it("adds a flagged image and still files a report naming the emoji", async () => {
    configureScanner(scores({ sexual: 0.02, "violence/graphic": 0.95 }));
    const key = await mint();
    const claimed = await claim(key);
    expect(claimed.status).toBe(201);

    const [row] = await emojiRows();
    expect(row!.scan_status).toBe("flagged");
    const filed = await reports();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.reason).toBe("violence");
    expect(filed[0]!.server_id).toBeNull();
    expect(filed[0]!.details).toContain(claimed.body.emoji!.id);
  });

  it("refuses an image the scanner could not judge, and discards it", async () => {
    configureScanner(() => {
      throw new TypeError("fetch failed");
    });
    const key = await mint();
    const claimed = await claim(key);
    expect(claimed.status).toBe(400);
    expect(claimed.body.code).toBe("emoji_upload_unverified");
    expect(await emojiRows()).toEqual([]);
    // Nothing was found wrong with it: not evidence.
    expect(await quarantineRows()).toEqual([]);
    await flushDiscards();
    expect(stored.size).toBe(0);
  });

  it("adds an unjudgeable image only when the operator chose to fail open", async () => {
    process.env.CONTENT_SCAN_FAIL_MODE = "open";
    configureScanner(() => {
      throw new TypeError("fetch failed");
    });
    expect((await claim(await mint())).status).toBe(201);
    expect((await emojiRows())[0]!.scan_status).toBe("error");
  });

  it("refuses the claim when the bytes cannot be pinned", async () => {
    configureScanner(scores({ sexual: 0.01 }));
    copyFails = true;
    const claimed = await claim(await mint());
    expect(claimed.status).toBe(400);
    expect(scannerCalls).toBe(0);
    expect(await emojiRows()).toEqual([]);
  });

  it("refuses a claim that names a pinned key", async () => {
    configureScanner(scores({ sexual: 0.01 }));
    expect((await claim(await mint())).status).toBe(201);
    const [row] = await emojiRows();

    const reused = await claim(row!.storage_key, "pog_two");
    expect(reused.status).toBe(400);
    expect(reused.body.code).toBe("emoji_upload_unverified");
    expect(await emojiRows()).toHaveLength(1);
  });

  it("expires an ordinary quarantine and never an illegal one", async () => {
    const insert = (key: string, labels: string[], age: string) =>
      getPool().query(
        `INSERT INTO server_emoji_quarantine
           (server_id, uploader_id, name, storage_key, scan_labels, quarantined_at)
         VALUES ($1, $2, 'x_x', $3, $4::jsonb, NOW() - $5::interval)`,
        [serverId, owner.id, key, JSON.stringify(labels), age],
      );
    await insert("servers/a/emoji/pinned/gore.png", ["gore"], "60 days");
    await insert("servers/a/emoji/pinned/illegal.png", ["csam_suspected"], "3650 days");
    await insert("servers/a/emoji/pinned/fresh.png", ["gore"], "10 days");

    expect(await sweepQuarantinedServerEmoji()).toBe(1);
    expect(deletedKeys).toEqual(["servers/a/emoji/pinned/gore.png"]);
    expect((await quarantineRows()).map((row) => row.storage_key).sort()).toEqual([
      "servers/a/emoji/pinned/fresh.png",
      "servers/a/emoji/pinned/illegal.png",
    ]);

    process.env.CONTENT_SCAN_QUARANTINE_DAYS = "7";
    expect(await sweepQuarantinedServerEmoji()).toBe(1);
    expect((await quarantineRows()).map((row) => row.storage_key)).toEqual([
      "servers/a/emoji/pinned/illegal.png",
    ]);
  });
});
