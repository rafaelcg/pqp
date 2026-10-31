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
import { allReportPageSchema, reportAttachmentRevealSchema } from "@pqp/shared";

/**
 * The attachments on a reported message, and the one-click reveal, on a real
 * Postgres. What is pinned, in the order a moderator meets it:
 *
 *   * the LIST (kind, content type, scanner verdict) is served with the flag
 *     off, and only for the reported message;
 *   * the reveal route is a 404 with the flag off, and for everyone who may not
 *     read the report, and for an attachment that is not the report's;
 *   * the guardrails refuse flagged / rejected / error, an illegal or
 *     csam_suspected label, a quarantined object, a minor-in-sexual-content
 *     report and anything that is not a picture, with nothing audited;
 *   * a granted reveal is a 60 second URL, never cached, audited before it is
 *     handed out, and the URL is in no log line.
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

const { getPool, initDb, closePool } = await import("../db.js");
const { handleApi, resetApiRateLimits } = await import("./index.js");
const { upsertUser } = await import("../services/users.js");
const { createServer: createChatServer } = await import("../services/servers.js");
const { openConversation } = await import("../services/dms.js");
const { createReport, resolveReport } = await import("../services/reports.js");

let httpServer: Server;
let baseUrl: string;

type Person = { id: string; clerk_id: string };

async function call<T = Record<string, unknown>>(
  as: Person | null,
  method: string,
  path: string,
): Promise<{ status: number; body: T; headers: Headers }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

const STORAGE_ENV = {
  S3_ENDPOINT: "https://storage.test",
  S3_BUCKET: "pqp-test",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_FORCE_PATH_STYLE: "true",
} as const;

describeDb("report attachments", () => {
  let owner: Person;
  let admin: Person;
  let reporter: Person;
  let poster: Person; // the reported account
  let bystander: Person; // plain member of Alpha
  let operator: Person;

  let alphaId: string;
  let alphaChannel: string;

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
    process.env.INSTANCE_MODERATOR_CLERK_IDS = "clerk_operator";
    for (const [name, value] of Object.entries(STORAGE_ENV)) {
      process.env[name] = value;
    }
    delete process.env.REPORT_ATTACHMENT_PREVIEW;

    const make = (name: string) =>
      upsertUser({ clerkId: `clerk_${name}`, displayName: name, avatarUrl: null });
    owner = await make("owner");
    admin = await make("admin");
    reporter = await make("reporter");
    poster = await make("poster");
    bystander = await make("bystander");
    operator = await make("operator");

    const alpha = await createChatServer("Alpha", owner.id);
    alphaId = alpha.server.id;
    alphaChannel = alpha.channels.find((c) => c.type === "text")!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role)
       SELECT $1, u, r FROM (VALUES ($2::uuid, 'admin'), ($3::uuid, 'member'),
         ($4::uuid, 'member'), ($5::uuid, 'member')) AS t(u, r)`,
      [alphaId, admin.id, reporter.id, poster.id, bystander.id],
    );
  });

  afterEach(() => {
    for (const name of [
      ...Object.keys(STORAGE_ENV),
      "REPORT_ATTACHMENT_PREVIEW",
    ]) {
      delete process.env[name];
    }
    vi.restoreAllMocks();
  });

  async function say(channel: string, who: Person, body: string) {
    // Straight into the table: an image-only message has an empty body, which
    // `createMessage` refuses on its own (the attachment claim is what makes it
    // legal), and this suite is about the row that results.
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body)
       VALUES ($1, $2, $3) RETURNING id`,
      [channel, who.id, body],
    );
    return result.rows[0]!.id;
  }

  interface AttachmentSeed {
    contentType?: string;
    scanStatus?: string;
    provider?: string | null;
    score?: number | null;
    labels?: string[];
    quarantined?: boolean;
    remoteUrl?: string;
  }

  async function attach(
    messageId: string,
    channelId: string,
    uploader: Person,
    seed: AttachmentSeed = {},
  ): Promise<string> {
    const contentType = seed.contentType ?? "image/png";
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO message_attachments
         (message_id, channel_id, uploader_id, storage_key, remote_url, filename,
          content_type, byte_size, scan_status, scan_provider, scan_score,
          scan_labels, quarantined_at, scanned_at)
       VALUES ($1, $2, $3, $4, $5, 'file', $6, 1234, $7, $8, $9, $10::jsonb,
               CASE WHEN $11 THEN NOW() END, NOW())
       RETURNING id`,
      [
        messageId,
        channelId,
        uploader.id,
        seed.remoteUrl ? null : `key/${Math.random().toString(36).slice(2)}`,
        seed.remoteUrl ?? null,
        contentType,
        seed.scanStatus ?? "pass",
        seed.provider === undefined ? "openai" : seed.provider,
        seed.score === undefined ? 0.01 : seed.score,
        JSON.stringify(seed.labels ?? []),
        seed.quarantined ?? false,
      ],
    );
    return result.rows[0]!.id;
  }

  /** An image-only message in Alpha, reported by `reporter`. */
  async function reportedImage(seed: AttachmentSeed = {}, reason: "spam" | "minor_sexual" = "spam") {
    const messageId = await say(alphaChannel, poster, "");
    const attachmentId = await attach(messageId, alphaChannel, poster, seed);
    const { report } = await createReport({
      subjectType: "message",
      reporterId: reporter.id,
      messageId,
      reason,
    });
    return { messageId, attachmentId, report };
  }

  const revealPath = (reportId: string, attachmentId: string) =>
    `/api/reports/${reportId}/attachments/${attachmentId}/reveal`;

  async function auditRows() {
    const result = await getPool().query(
      `SELECT actor_id, action, target_type, target_id::text AS target_id,
              changes
       FROM audit_log WHERE action = 'report.attachment_reveal'`,
    );
    return result.rows;
  }

  // ------------------------------------------------------------- the list

  describe("the attachment list", () => {
    it("is served with the flag off, for the reported message only", async () => {
      const { messageId, attachmentId, report } = await reportedImage({
        contentType: "image/gif",
        provider: "sightengine",
        score: 0.12,
        labels: ["gore"],
        scanStatus: "pass",
      });
      // Another message in the same channel by the same author: must not appear.
      const other = await say(alphaChannel, poster, "neighbour");
      await attach(other, alphaChannel, poster, { contentType: "image/jpeg" });
      // A second file on the reported message.
      await attach(messageId, alphaChannel, poster, {
        contentType: "video/mp4",
        scanStatus: "skipped",
        provider: null,
        score: null,
      });

      const all = await call(operator, "GET", "/api/reports/all");
      expect(all.status).toBe(200);
      const page = allReportPageSchema.parse(all.body);
      const row = page.reports.find((r) => r.id === report.id)!;
      expect(row.attachments).toHaveLength(2);
      const gif = row.attachments.find((a) => a.id === attachmentId)!;
      expect(gif).toMatchObject({
        kind: "gif",
        contentType: "image/gif",
        scan: {
          status: "pass",
          provider: "sightengine",
          score: expect.closeTo(0.12, 2),
          labels: ["gore"],
        },
        preview: "off",
        blockReason: null,
      });
      const video = row.attachments.find((a) => a.kind === "video")!;
      expect(video.preview).toBe("unsupported");
      expect(JSON.stringify(all.body)).not.toContain("storage.test");
    });

    it("reaches a server's own staff on their queue, with the flag on", async () => {
      process.env.REPORT_ATTACHMENT_PREVIEW = "true";
      const { attachmentId, report } = await reportedImage();
      const queue = await call<{ reports: Array<{ id: string; attachments: Array<{ id: string; preview: string }> }> }>(
        owner,
        "GET",
        `/api/servers/${alphaId}/reports`,
      );
      expect(queue.status).toBe(200);
      const row = queue.body.reports.find((r) => r.id === report.id)!;
      expect(row.attachments).toEqual([
        expect.objectContaining({ id: attachmentId, preview: "available" }),
      ]);
    });

    it("says blocked, and why, for what the runbook says never to open", async () => {
      const cases: Array<[AttachmentSeed, string]> = [
        [{ scanStatus: "flagged", labels: ["gore"] }, "scan_status"],
        [{ scanStatus: "rejected", labels: ["gore"], quarantined: true }, "quarantined"],
        [{ scanStatus: "error", provider: "openai", score: null }, "scan_status"],
        [{ scanStatus: "flagged", labels: ["illegal"] }, "illegal_label"],
        [{ scanStatus: "pass", labels: ["csam_suspected"] }, "illegal_label"],
      ];
      process.env.REPORT_ATTACHMENT_PREVIEW = "true";
      for (const [seed, reason] of cases) {
        const { report } = await reportedImage(seed);
        const all = await call(operator, "GET", "/api/reports/all");
        const row = allReportPageSchema
          .parse(all.body)
          .reports.find((r) => r.id === report.id)!;
        expect(row.attachments[0]).toMatchObject({
          preview: "blocked",
          blockReason: reason,
        });
      }
    });
  });

  // ------------------------------------------------------------ the reveal

  describe("POST /api/reports/:id/attachments/:attachmentId/reveal", () => {
    it("is a 404 with the flag off, even for an instance moderator", async () => {
      const { attachmentId, report } = await reportedImage();
      const res = await call(operator, "POST", revealPath(report.id, attachmentId));
      expect(res.status).toBe(404);
      expect(await auditRows()).toHaveLength(0);
    });

    describe("with the flag on", () => {
      beforeEach(() => {
        process.env.REPORT_ATTACHMENT_PREVIEW = "true";
      });

      it("hands an instance moderator a 60 second, uncached URL and audits it first", async () => {
        const logs = [
          vi.spyOn(console, "log").mockImplementation(() => {}),
          vi.spyOn(console, "error").mockImplementation(() => {}),
          vi.spyOn(console, "warn").mockImplementation(() => {}),
          vi.spyOn(console, "info").mockImplementation(() => {}),
        ];
        const { attachmentId, report } = await reportedImage();
        const res = await call(operator, "POST", revealPath(report.id, attachmentId));
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const body = reportAttachmentRevealSchema.parse(res.body);
        expect(body.expiresInSeconds).toBe(60);
        const url = new URL(body.url);
        expect(url.host).toBe("storage.test");
        expect(url.searchParams.get("X-Amz-Expires")).toBe("60");

        const rows = await auditRows();
        expect(rows).toEqual([
          expect.objectContaining({
            actor_id: operator.id,
            target_type: "attachment",
            target_id: attachmentId,
            changes: [{ key: "report", old: null, new: report.id }],
          }),
        ]);
        // Nothing the process logged, and nothing it stored, carries the URL.
        const logged = logs
          .flatMap((spy) => spy.mock.calls)
          .map((args) => args.map(String).join(" "))
          .join("\n");
        expect(logged).toContain(`attachment ${attachmentId}`);
        expect(logged).not.toContain(url.searchParams.get("X-Amz-Signature")!);
        expect(logged).not.toContain("storage.test");
        expect(JSON.stringify(rows)).not.toContain("storage.test");
      });

      it("serves a server's own staff on a report in their queue, and nobody else in it", async () => {
        const { attachmentId, report } = await reportedImage();
        const path = revealPath(report.id, attachmentId);
        expect((await call(owner, "POST", path)).status).toBe(200);
        expect((await call(admin, "POST", path)).status).toBe(200);
        // A plain member, the reporter and the reported account: the same 404 a
        // missing report gets.
        for (const who of [bystander, reporter, poster]) {
          expect((await call(who, "POST", path)).status).toBe(404);
        }
        expect(
          (await call(operator, "POST", revealPath("99999", attachmentId))).status,
        ).toBe(404);
        expect((await auditRows()).map((r) => r.actor_id).sort()).toEqual(
          [owner.id, admin.id].sort(),
        );
      });

      it("treats another message's attachment, a stranger's id and garbage as not found", async () => {
        const { report } = await reportedImage();
        const neighbour = await say(alphaChannel, poster, "next door");
        const foreign = await attach(neighbour, alphaChannel, poster);
        const missing = "00000000-0000-4000-8000-000000000000";
        for (const id of [foreign, missing, "not-a-uuid"]) {
          const res = await call(operator, "POST", revealPath(report.id, id));
          expect(res.status).toBe(404);
        }
        expect(await auditRows()).toHaveLength(0);
      });

      it("refuses what the runbook says never to open, with a reason, and audits nothing", async () => {
        const refused: AttachmentSeed[] = [
          { scanStatus: "flagged", labels: ["gore"] },
          { scanStatus: "rejected", labels: ["gore"], quarantined: true },
          { scanStatus: "error", score: null },
          { scanStatus: "flagged", labels: ["illegal"] },
          { scanStatus: "pass", labels: ["csam_suspected"] },
          { scanStatus: "pass", quarantined: true },
        ];
        for (const seed of refused) {
          const { attachmentId, report } = await reportedImage(seed);
          const res = await call<{ error: string }>(
            operator,
            "POST",
            revealPath(report.id, attachmentId),
          );
          expect(res.status).toBe(403);
          expect(res.body.error).toMatch(/Preview refused/);
          expect(res.body.error).toMatch(/runbook/);
          expect(JSON.stringify(res.body)).not.toContain("storage.test");
        }
        expect(await auditRows()).toHaveLength(0);
      });

      it("refuses a message reported as a minor in sexual content, beside any other report", async () => {
        const { messageId, attachmentId, report } = await reportedImage(
          {},
          "minor_sexual",
        );
        expect(
          (await call(operator, "POST", revealPath(report.id, attachmentId))).status,
        ).toBe(403);
        // The ordinary report on the same message is refused too: the file is
        // the same file.
        const second = await createReport({
          subjectType: "message",
          reporterId: bystander.id,
          messageId,
          reason: "spam",
        });
        expect(
          (await call(operator, "POST", revealPath(second.report.id, attachmentId)))
            .status,
        ).toBe(403);
        expect(await auditRows()).toHaveLength(0);
      });

      it("never previews a video or a file", async () => {
        for (const contentType of ["video/mp4", "application/pdf", "image/svg+xml"]) {
          const { attachmentId, report } = await reportedImage({ contentType });
          const res = await call(operator, "POST", revealPath(report.id, attachmentId));
          expect(res.status).toBe(403);
        }
        expect(await auditRows()).toHaveLength(0);
      });

      it("allows a picture nobody has scanned, which the card labels as such", async () => {
        const { attachmentId, report } = await reportedImage({
          scanStatus: "unscanned",
          provider: null,
          score: null,
        });
        expect(
          (await call(operator, "POST", revealPath(report.id, attachmentId))).status,
        ).toBe(200);
      });

      it("passes a remote gif's own URL through, unsigned", async () => {
        const { attachmentId, report } = await reportedImage({
          contentType: "image/gif",
          remoteUrl: "https://media.klipy.test/cat.gif",
        });
        const res = await call<{ url: string }>(
          operator,
          "POST",
          revealPath(report.id, attachmentId),
        );
        expect(res.status).toBe(200);
        expect(res.body.url).toBe("https://media.klipy.test/cat.gif");
      });

      it("stops answering a long-closed report, and still answers a recent one", async () => {
        const recent = await reportedImage();
        await resolveReport(recent.report.id, operator.id, "dismissed");
        expect(
          (
            await call(
              operator,
              "POST",
              revealPath(recent.report.id, recent.attachmentId),
            )
          ).status,
        ).toBe(200);

        const old = await reportedImage();
        await resolveReport(old.report.id, operator.id, "dismissed");
        await getPool().query(
          `UPDATE reports SET resolved_at = NOW() - interval '31 days' WHERE id = $1`,
          [old.report.id],
        );
        expect(
          (await call(operator, "POST", revealPath(old.report.id, old.attachmentId)))
            .status,
        ).toBe(404);
      });

      it("rate limits per moderator", async () => {
        const { attachmentId, report } = await reportedImage();
        const path = revealPath(report.id, attachmentId);
        const statuses: number[] = [];
        for (let i = 0; i < 12; i += 1) {
          statuses.push((await call(owner, "POST", path)).status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
        expect(statuses.at(-1)).toBe(429);
        // Another moderator has a bucket of their own.
        expect((await call(operator, "POST", path)).status).toBe(200);
      });

      it("works for a conversation report, for an instance moderator only, with no audit row", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const convo = await openConversation(poster.id, [reporter.id]);
        const messageId = await say(convo.channelId, poster, "");
        const attachmentId = await attach(messageId, convo.channelId, poster);
        const { report } = await createReport({
          subjectType: "message",
          reporterId: reporter.id,
          messageId,
          reason: "harassment",
        });
        const path = revealPath(report.id, attachmentId);
        // The server's owner and admin have no business in a DM report.
        for (const who of [owner, admin, reporter, poster]) {
          expect((await call(who, "POST", path)).status).toBe(404);
        }
        const res = await call(operator, "POST", path);
        expect(res.status).toBe(200);
        expect(await auditRows()).toHaveLength(0);
        const logged = log.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
        expect(logged).toContain(`report ${report.id}, attachment ${attachmentId}`);
        expect(logged).not.toContain("storage.test");
      });
    });
  });
});
