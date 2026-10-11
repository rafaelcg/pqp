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
 * Baú media goes through the same image scan as chat attachments, on the
 * media claim, before anything can put it on a post. The router, the
 * permission check, the reports table and Postgres are real; storage is an
 * in-memory stand-in and the scanner is the real `openai` adapter talking to a
 * stubbed `fetch` (every other request, i.e. this test's own HTTP calls to the
 * API, goes to the real one).
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
  getObjectPrefix: async (key: string, length: number) =>
    stored.get(key)?.bytes.subarray(0, length) ?? null,
  deleteObject: async (key: string) => {
    deletedKeys.push(key);
    stored.delete(key);
  },
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("../api/index.js");
const { upsertUser } = await import("./users.js");
const { createServer: createChatServer } = await import("./servers.js");
const { sweepOrphanedCommunityHomeMedia } = await import("./community-home.js");
const { sweepQuarantinedCommunityHomeMedia } = await import(
  "./community-home-scan.js"
);
const { listAllReports } = await import("./reports.js");

const realFetch = globalThis.fetch;
let httpServer: Server;
let baseUrl: string;

/** What the stubbed provider answers, and how many times it was asked. */
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
  as: { id: string; clerk_id: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await realFetch(`${baseUrl}${path}`, {
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
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);

const SCAN_ENV = [
  "CONTENT_SCAN_PROVIDER",
  "CONTENT_SCAN_FAIL_MODE",
  "CONTENT_SCAN_QUARANTINE_DAYS",
  "OPENAI_API_KEY",
] as const;

describeDb("Baú media image scan", () => {
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
    scanner = null;
    scannerCalls = 0;
    for (const key of SCAN_ENV) {
      delete process.env[key];
    }
    process.env.COMMUNITY_HOME_ENABLED = "true";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
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
    owner = await upsertUser({
      clerkId: "clerk_owner",
      displayName: "owner",
      avatarUrl: null,
    });
    serverId = (await createChatServer("Mesa da Tues", owner.id)).server.id;
  });

  afterEach(() => {
    delete process.env.COMMUNITY_HOME_ENABLED;
    for (const key of SCAN_ENV) {
      delete process.env[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mint(
    contentType = "image/png",
    bytes: Buffer = PNG,
    filename = "foto.png",
  ): Promise<string> {
    const minted = await call<{ uploadId: string; key: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/media`,
      { contentType, byteSize: bytes.length, filename },
    );
    expect(minted.status).toBe(201);
    stored.set(minted.body.key, { bytes, contentType });
    return minted.body.uploadId;
  }

  function claim(uploadId: string) {
    return call<{ error?: string; kind?: string }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/media/claim`,
      { uploadId },
    );
  }

  function publish(mediaUploadId: string) {
    return call<{ error?: string; post?: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/home/posts`,
      { title: "Lançamento", mediaUploadId, status: "published" },
    );
  }

  async function uploadRow(uploadId: string) {
    const result = await getPool().query<{
      scan_status: string;
      scan_provider: string | null;
      scan_labels: string[] | null;
      scanned_at: Date | null;
      quarantined_at: Date | null;
      verified_at: Date | null;
    }>(
      `SELECT scan_status, scan_provider, scan_labels, scanned_at,
              quarantined_at, verified_at
         FROM community_home_media_uploads WHERE id = $1`,
      [uploadId],
    );
    return result.rows[0]!;
  }

  async function reports() {
    const result = await getPool().query<{
      reporter_id: string | null;
      reported_user_id: string;
      context_kind: string;
      server_id: string | null;
      channel_label: string | null;
      reason: string;
      details: string;
    }>(
      `SELECT reporter_id, reported_user_id, context_kind, server_id,
              channel_label, reason, details
         FROM reports ORDER BY id`,
    );
    return result.rows;
  }

  async function age(uploadId: string, interval: string): Promise<void> {
    await getPool().query(
      `UPDATE community_home_media_uploads
          SET created_at = NOW() - $2::interval
        WHERE id = $1`,
      [uploadId, interval],
    );
  }

  it("claims and records nothing when no scanner is configured", async () => {
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(200);

    expect(scannerCalls).toBe(0);
    const row = await uploadRow(uploadId);
    // Not `pass`: nobody looked, and the row says so.
    expect(row.scan_status).toBe("unscanned");
    expect(row.scan_provider).toBeNull();
    expect(row.verified_at).not.toBeNull();
    expect(await reports()).toEqual([]);
  });

  it("claims a clean image and records who said so", async () => {
    configureScanner(scores({ sexual: 0.01, "violence/graphic": 0.02 }));
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(200);

    const row = await uploadRow(uploadId);
    expect(row.scan_status).toBe("pass");
    expect(row.scan_provider).toBe("openai");
    expect(row.scanned_at).not.toBeNull();
    expect(row.quarantined_at).toBeNull();
    expect((await publish(uploadId)).status).toBe(201);
    expect(await reports()).toEqual([]);
  });

  it("refuses a rejected image, quarantines it, and reports it to the instance queue", async () => {
    configureScanner(scores({ sexual: 0.98, "sexual/minors": 0.97 }));
    const uploadId = await mint();

    const claimed = await claim(uploadId);
    expect(claimed.status).toBe(400);
    // The same words as a failed HEAD: the uploader is not told why.
    expect(claimed.body.error).toMatch(/could not be verified/i);

    const row = await uploadRow(uploadId);
    expect(row.scan_status).toBe("rejected");
    expect(row.scan_labels).toEqual(["csam_suspected"]);
    expect(row.quarantined_at).not.toBeNull();
    expect(row.verified_at).toBeNull();

    // Nothing can carry it onto a post.
    const post = await publish(uploadId);
    expect(post.status).toBe(400);
    const posts = await getPool().query(`SELECT id FROM community_home_posts`);
    expect(posts.rows).toEqual([]);

    const filed = await reports();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.reporter_id).toBeNull();
    expect(filed[0]!.reported_user_id).toBe(owner.id);
    // The uploader is staff of this server by construction, so the finding must
    // not land in the queue they read.
    expect(filed[0]!.context_kind).toBe("none");
    expect(filed[0]!.server_id).toBeNull();
    expect(filed[0]!.channel_label).toBe("Baú · Mesa da Tues");
    expect(filed[0]!.reason).toBe("illegal_content");
    expect(filed[0]!.details).toContain(`Baú upload ${uploadId}`);
    expect(filed[0]!.details).toContain("never posted");

    // And the operator's all-reports page reads the evidence back.
    const all = await listAllReports({ limit: 10 });
    expect(all.reports[0]!.scan).toMatchObject({
      status: "rejected",
      labels: ["csam_suspected"],
      provider: "openai",
      contentType: "image/png",
      stillAttached: false,
    });
  });

  it("refuses a quarantined upload again without asking the scanner", async () => {
    configureScanner(scores({ sexual: 0.98, "sexual/minors": 0.97 }));
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(400);
    expect(scannerCalls).toBe(1);

    // A provider that would now say yes does not get asked.
    scanner = scores({ sexual: 0.01 });
    expect((await claim(uploadId)).status).toBe(400);
    expect(scannerCalls).toBe(1);
    expect((await uploadRow(uploadId)).scan_status).toBe("rejected");
  });

  it("posts a flagged image and still files a report", async () => {
    configureScanner(scores({ sexual: 0.02, "violence/graphic": 0.95 }));
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(200);

    const row = await uploadRow(uploadId);
    expect(row.scan_status).toBe("flagged");
    expect(row.quarantined_at).toBeNull();
    expect((await publish(uploadId)).status).toBe(201);

    const filed = await reports();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.reason).toBe("violence");
    expect(filed[0]!.server_id).toBeNull();
    expect(filed[0]!.details).toContain("is visible");
  });

  it("refuses an image the scanner could not judge, and lets a retry scan again", async () => {
    configureScanner(() => {
      throw new TypeError("fetch failed");
    });
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(400);

    const row = await uploadRow(uploadId);
    expect(row.scan_status).toBe("error");
    expect(row.scan_labels).toEqual(["scan_error:unreachable"]);
    // Nothing was found wrong with it: ordinary unclaimed garbage, not evidence.
    expect(row.quarantined_at).toBeNull();
    expect(row.verified_at).toBeNull();

    // An error is not a verdict. Once the provider is back, a retry is judged.
    scanner = scores({ sexual: 0.01 });
    expect((await claim(uploadId)).status).toBe(200);
    expect((await uploadRow(uploadId)).scan_status).toBe("pass");
  });

  it("claims an unjudgeable image only when the operator chose to fail open", async () => {
    process.env.CONTENT_SCAN_FAIL_MODE = "open";
    configureScanner(() => {
      throw new TypeError("fetch failed");
    });
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(200);
    // The row still says what happened.
    expect((await uploadRow(uploadId)).scan_status).toBe("error");
  });

  it("does not ask the scanner again for an upload it already passed", async () => {
    configureScanner(scores({ sexual: 0.01 }));
    const uploadId = await mint();
    expect((await claim(uploadId)).status).toBe(200);
    expect((await claim(uploadId)).status).toBe(200);
    expect(scannerCalls).toBe(1);
  });

  it("records a video as skipped, which is not a pass", async () => {
    configureScanner(scores({ sexual: 0.01 }));
    const uploadId = await mint("video/mp4", MP4, "clip.mp4");
    expect((await claim(uploadId)).status).toBe(200);
    expect(scannerCalls).toBe(0);
    const row = await uploadRow(uploadId);
    expect(row.scan_status).toBe("skipped");
    expect(row.scan_provider).toBe("openai");
  });

  it("keeps a quarantined upload out of the orphan sweep's reach", async () => {
    configureScanner(scores({ sexual: 0.98, "sexual/minors": 0.97 }));
    const refused = await mint();
    expect((await claim(refused)).status).toBe(400);
    const abandoned = await mint();
    await age(refused, "2 hours");
    await age(abandoned, "2 hours");

    // Both are unclaimed, unverified and past the grace period. Only the one
    // nobody scanned is garbage.
    expect(await sweepOrphanedCommunityHomeMedia()).toBe(1);
    expect((await uploadRow(refused)).scan_status).toBe("rejected");
    const left = await getPool().query<{ id: string }>(
      `SELECT id FROM community_home_media_uploads`,
    );
    expect(left.rows.map((entry) => entry.id)).toEqual([refused]);
  });

  it("expires an ordinary quarantine and never an illegal one", async () => {
    const gore = await mint();
    const illegal = await mint();
    const fresh = await mint();
    await getPool().query(
      `UPDATE community_home_media_uploads
          SET scan_status = 'rejected', scan_labels = '["gore"]'::jsonb,
              quarantined_at = NOW() - INTERVAL '60 days'
        WHERE id = $1`,
      [gore],
    );
    await getPool().query(
      `UPDATE community_home_media_uploads
          SET scan_status = 'rejected', scan_labels = '["csam_suspected"]'::jsonb,
              quarantined_at = NOW() - INTERVAL '3650 days'
        WHERE id = $1`,
      [illegal],
    );
    await getPool().query(
      `UPDATE community_home_media_uploads
          SET scan_status = 'rejected', scan_labels = '["gore"]'::jsonb,
              quarantined_at = NOW() - INTERVAL '10 days'
        WHERE id = $1`,
      [fresh],
    );

    expect(await sweepQuarantinedCommunityHomeMedia()).toBe(1);
    expect(deletedKeys).toHaveLength(1);
    const left = await getPool().query<{ id: string }>(
      `SELECT id FROM community_home_media_uploads ORDER BY created_at`,
    );
    expect(left.rows.map((entry) => entry.id).sort()).toEqual(
      [illegal, fresh].sort(),
    );

    process.env.CONTENT_SCAN_QUARANTINE_DAYS = "7";
    expect(await sweepQuarantinedCommunityHomeMedia()).toBe(1);
  });
});
