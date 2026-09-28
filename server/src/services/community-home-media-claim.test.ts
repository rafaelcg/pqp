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
 * The Baú media claim looks at the stored bytes, not just the Content-Type the
 * upload was signed with. A 17-byte text file called `x.png` used to claim
 * cleanly and render as a broken image on the feed. Storage is an in-memory
 * stand-in; the router, the permission check and Postgres are real.
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

/** What "storage" holds, by key: the bytes and the Content-Type it kept. */
const stored = new Map<string, { bytes: Buffer; contentType: string }>();
let storageDown = false;

vi.mock("../lib/s3.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/s3.js")>()),
  isStorageConfigured: () => true,
  presignPut: (key: string) => `http://storage.test/${key}`,
  headObject: async (key: string) => {
    const object = stored.get(key);
    return object
      ? { contentLength: object.bytes.length, contentType: object.contentType }
      : null;
  },
  getObjectPrefix: async (key: string, length: number) => {
    if (storageDown) {
      throw new Error("storage unreachable");
    }
    return stored.get(key)?.bytes.subarray(0, length) ?? null;
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");

let httpServer: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
  0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00");

describeDb("community home media claim", () => {
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
    storageDown = false;
    process.env.COMMUNITY_HOME_ENABLED = "true";
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "owner",
      avatarUrl: null,
    });
    serverId = (await createChatServer("Mesa da Tues", owner.id)).server.id;
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
  });

  /** Mint an upload, "PUT" the bytes under the signed type, then claim. */
  async function mintAndClaim(
    contentType: string,
    bytes: Buffer,
    filename = "foto.png",
  ) {
    const minted = await call<{ uploadId: string; key: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/media`,
      { contentType, byteSize: bytes.length, filename },
    );
    expect(minted.status).toBe(201);
    stored.set(minted.body.key, { bytes, contentType });
    return call<{ error?: string; kind?: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/media/claim`,
      { uploadId: minted.body.uploadId },
    );
  }

  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/webp", WEBP],
    ["image/gif", GIF],
  ])("claims a real %s", async (contentType, bytes) => {
    const res = await mintAndClaim(contentType, bytes);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("image");
  });

  it("refuses a text file named .png", async () => {
    const res = await mintAndClaim(
      "image/png",
      Buffer.from("this is not a png"),
      "notimage.png",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid image/i);
  });

  it("refuses real image bytes stored under another declared type", async () => {
    const res = await mintAndClaim("image/png", JPEG);
    expect(res.status).toBe(400);
  });

  it("refuses when the stored bytes cannot be read", async () => {
    storageDown = true;
    const res = await mintAndClaim("image/png", PNG);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/could not be verified/i);
  });

  it("leaves a PDF alone, since only images are sniffed", async () => {
    const res = await mintAndClaim(
      "application/pdf",
      Buffer.from("%PDF-1.7\n"),
      "doc.pdf",
    );
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("file");
  });
});
