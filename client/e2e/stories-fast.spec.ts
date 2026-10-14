import { createHash, createHmac } from "node:crypto";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

/**
 * Fast stories, end to end: the file goes up while the author is still editing,
 * Post closes the composer at once and only has to create and publish, the ring
 * carries progress and a failed post, and throwing a draft away deletes what was
 * already uploaded.
 *
 * Two kinds of test. The first runs everywhere: object storage is stubbed at the
 * network, so it pins what the CLIENT does (which requests, in which order, and
 * how quickly the composer closes) with no bucket. The rest need the real thing
 * (`docker compose --profile storage up -d`, and `S3_ENDPOINT` / `S3_BUCKET` /
 * `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` exported, see
 * `playwright.config.ts`): they upload to MinIO, read the bucket back with a
 * signed HEAD, and skip with a note when storage is off.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

test.setTimeout(150_000);

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["camera", "microphone"],
});

function headersFor(suffix: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEV_TOKEN}:${suffix}` };
}

async function setup() {
  const suffix = `st-fast-${Date.now().toString(36)}${Math.floor(Math.random() * 100)}`.toLowerCase().slice(0, 32);
  const headers = headersFor(suffix);
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as { ageGate?: string };
  if (me.ageGate && me.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, { method: "POST", headers, body: JSON.stringify({ dateOfBirth: "1990-01-01" }) });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ onboardedAt: new Date().toISOString(), firstRunDismissedAt: new Date().toISOString() }),
  });
  const created = await fetch(`${API}/api/servers`, { method: "POST", headers, body: JSON.stringify({ name: `Fast ${Date.now()}` }) });
  const { server } = (await created.json()) as { server: { id: string } };
  const channels = (await (await fetch(`${API}/api/servers/${server.id}/channels`, { headers })).json()) as {
    channels: { id: string; type: string }[];
  };
  const flag = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "stories", serverId: server.id, enabled: true }),
  });
  expect(flag.status).toBe(200);
  const config = (await (await fetch(`${API}/api/stories/config`, { headers })).json()) as { mediaEnabled?: boolean };
  return {
    suffix,
    serverId: server.id,
    channelId: channels.channels.find((c) => c.type === "text")!.id,
    storage: Boolean(config.mediaEnabled),
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function openComposer(page: Page, ctx: Ctx, size = { width: 1440, height: 900 }) {
  await page.setViewportSize(size);
  await page.addInitScript((value) => localStorage.setItem("pqp:dev-user-suffix", value), ctx.suffix);
  await page.goto(`/app/server/${ctx.serverId}/channel/${ctx.channelId}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  await page.locator("[data-server-menu-trigger]").first().click();
  await page.getByRole("menuitem", { name: "Post a story" }).click();
  const composer = page.getByRole("dialog", { name: "New story" });
  await expect(composer).toBeVisible();
  return composer;
}

/** A noisy JPEG of roughly `kb` kilobytes, made in the page (nothing to ship in the repo). */
async function noisePhoto(page: Page, kb: number): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const base64 = await page.evaluate(async (target) => {
    const side = Math.ceil(Math.sqrt((target * 1024) / 1.1));
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(side, side);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = Math.random() * 255;
      image.data[i + 1] = Math.random() * 255;
      image.data[i + 2] = Math.random() * 255;
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, kb);
  return { name: "noise.jpg", mimeType: "image/jpeg", buffer: Buffer.from(base64, "base64") };
}

async function attachPhoto(page: Page, composer: Locator, kb = 120) {
  await composer.locator("[data-story-file]").setInputFiles(await noisePhoto(page, kb));
  await expect(composer.locator("[data-story-audience]")).toBeVisible({ timeout: 20_000 });
  await expect(composer.locator("[data-story-post]")).toBeEnabled({ timeout: 20_000 });
}

/** A real click at the middle of the element, after checking it is what is there. */
async function realClick(page: Page, target: Locator, name: string) {
  const box = await target.boundingBox();
  expect(box, `${name} has a box`).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  const hit = await target.evaluate(
    (element, point) => {
      const found = document.elementFromPoint(point.x, point.y);
      return Boolean(found && (found === element || element.contains(found)));
    },
    { x, y },
  );
  expect(hit, `${name} is what a click on it reaches`).toBe(true);
  await page.mouse.click(x, y);
}

/** The "Your story" ring button of the server's strip, and the strip around it (where its label is). */
const ownRing = (page: Page, ctx: Ctx) => page.locator(`[data-story-ring="server:${ctx.serverId}:own"]`);
const strip = (page: Page, ctx: Ctx) => page.locator(`[data-story-strip="server:${ctx.serverId}"]`);

async function ownStoryIds(ctx: Ctx): Promise<string[]> {
  const strip = (await (
    await fetch(`${API}/api/servers/${ctx.serverId}/stories`, { headers: headersFor(ctx.suffix) })
  ).json()) as { own: { storyIds: string[] } | null };
  return strip.own?.storyIds ?? [];
}

/** The requests of one kind a page makes, in order, as `METHOD path`. */
function recordRequests(page: Page, match: RegExp): { list: string[]; bodies: unknown[] } {
  const list: string[] = [];
  const bodies: unknown[] = [];
  page.on("request", (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (match.test(path)) {
      list.push(`${request.method()} ${path}`);
      if (request.method() === "POST" && request.postData()) {
        try {
          bodies.push(JSON.parse(request.postData()!));
        } catch {
          bodies.push(null);
        }
      }
    }
  });
  return { list, bodies };
}

// ------------------------------------------------------------------ object storage, read back

function s3() {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY_ID;
  const secret = process.env.S3_SECRET_ACCESS_KEY;
  return endpoint && accessKey && secret
    ? { accessKey, secret, region: process.env.S3_REGION ?? "us-east-1" }
    : null;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** Whether the object a presigned PUT URL names exists, by a signed HEAD (path style, as MinIO). */
async function objectExists(presignedUrl: string): Promise<boolean> {
  const config = s3()!;
  const url = new URL(presignedUrl);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = createHash("sha256").update("").digest("hex");
  const canonical = [
    "HEAD",
    url.pathname,
    "",
    `host:${url.host}`,
    `x-amz-content-sha256:${payload}`,
    `x-amz-date:${amzDate}`,
    "",
    "host;x-amz-content-sha256;x-amz-date",
    payload,
  ].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secret}`, day), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const response = await fetch(`${url.origin}${url.pathname}`, {
    method: "HEAD",
    headers: {
      "x-amz-content-sha256": payload,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  });
  return response.status === 200;
}

async function discardComposer(page: Page, composer: Locator) {
  await realClick(page, composer.locator("[data-story-close]"), "close");
  await expect(composer.locator("[data-story-discard]")).toBeVisible();
  await realClick(page, composer.locator("[data-story-discard-confirm]"), "discard");
  await expect(composer).toHaveCount(0);
}

// ------------------------------------------------------------------ with the network stubbed: runs everywhere

/** What a bucket answers a browser's preflight and PUT with, so the page may read the result. */
const STUB_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

test("stubbed storage: the file starts at capture, Post closes at once and is one create-and-publish request", async ({ page }) => {
  const ctx = await setup();
  // The composer needs media on; the answers below are all the "server" there is.
  await page.route("**/api/stories/config*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, mediaEnabled: true, videoEnabled: false, eagerUploads: true } });
  });
  const requests = recordRequests(page, /^\/api\/stories(\/|$)/);
  const stored: string[] = [];
  await page.route("**/api/stories/uploads", async (route) => {
    await route.fulfill({
      status: 201,
      json: {
        uploadId: "00000000-0000-4000-8000-0000000000a1",
        url: "http://stub.pqp.test/bucket/base.jpg?sig=1",
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
  });
  await page.route("http://stub.pqp.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: STUB_CORS });
      return;
    }
    stored.push(route.request().method());
    await route.fulfill({ status: 200, headers: STUB_CORS, body: "" });
  });
  await page.route("**/api/stories", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    // A slow server on purpose: the composer must not be waiting for it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      status: 201,
      json: { story: { id: "00000000-0000-4000-8000-0000000000b1", own: { status: "live" } }, upload: null, layerUploads: [] },
    });
  });

  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer);
  // The upload was requested and sent before Post: at capture, not at the button.
  await expect.poll(() => stored.length).toBe(1);
  expect(requests.list).toContain("POST /api/stories/uploads");
  expect(requests.list).not.toContain("POST /api/stories");

  const t0 = Date.now();
  await realClick(page, composer.locator("[data-story-post]"), "Post");
  await expect(composer).toHaveCount(0, { timeout: 1000 });
  expect(Date.now() - t0, "the composer closes without waiting for the server").toBeLessThan(1000);
  await expect.poll(() => requests.list.filter((entry) => entry === "POST /api/stories").length).toBe(1);

  const create = requests.bodies.find((body) => (body as { kind?: string } | null)?.kind === "image") as {
    media: { uploadId: string };
    publish: boolean;
  };
  expect(create.media.uploadId).toBe("00000000-0000-4000-8000-0000000000a1");
  expect(create.publish).toBe(true);
  // One request, never a second publish, and the PUT was not repeated.
  await page.waitForTimeout(1800);
  expect(requests.list.filter((entry) => entry.endsWith("/publish"))).toEqual([]);
  expect(stored).toEqual(["PUT"]);
});

test("stubbed storage: with the kill switch off nothing is uploaded early and Post is the plain create, PUT, publish", async ({ page }) => {
  const ctx = await setup();
  await page.route("**/api/stories/config*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, mediaEnabled: true, videoEnabled: false, eagerUploads: false } });
  });
  const requests = recordRequests(page, /^\/api\/stories(\/|$)/);
  const stored: string[] = [];
  await page.route("http://stub.pqp.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: STUB_CORS });
      return;
    }
    stored.push(route.request().method());
    await route.fulfill({ status: 200, headers: STUB_CORS, body: "" });
  });
  await page.route("**/api/stories", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 201,
      json: {
        story: { id: "00000000-0000-4000-8000-0000000000b2", own: { status: "pending" } },
        upload: { url: "http://stub.pqp.test/bucket/plain.jpg?sig=1", method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: "" },
        layerUploads: [],
      },
    });
  });
  await page.route("**/api/stories/*/publish", (route) =>
    route.fulfill({ status: 200, json: { story: { id: "00000000-0000-4000-8000-0000000000b2", own: { status: "live" } } } }),
  );

  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer);
  await page.waitForTimeout(500);
  expect(requests.list.filter((entry) => entry.includes("/uploads"))).toEqual([]);
  expect(stored).toEqual([]);

  await realClick(page, composer.locator("[data-story-post]"), "Post");
  await expect(composer).toHaveCount(0, { timeout: 1000 });
  await expect.poll(() => requests.list.some((entry) => entry.endsWith("/publish"))).toBe(true);
  expect(stored).toEqual(["PUT"]);
  const create = requests.bodies.find((body) => (body as { kind?: string } | null)?.kind === "image") as {
    media: { uploadId?: string };
    publish?: boolean;
  };
  expect(create.media.uploadId).toBeUndefined();
  expect(create.publish).toBeUndefined();
});

test("stubbed storage: discarding the draft aborts the upload and asks the server to delete it", async ({ page }) => {
  const ctx = await setup();
  await page.route("**/api/stories/config*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, mediaEnabled: true, videoEnabled: false, eagerUploads: true } });
  });
  const requests = recordRequests(page, /^\/api\/stories\/uploads/);
  await page.route("**/api/stories/uploads", (route) =>
    route.fulfill({
      status: 201,
      json: {
        uploadId: "00000000-0000-4000-8000-0000000000a2",
        url: "http://stub.pqp.test/bucket/slow.jpg?sig=1",
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
  );
  await page.route("**/api/stories/uploads/*", (route) => route.fulfill({ status: 204, body: "" }));
  // The bytes never finish: the PUT is still in flight when the author gives up.
  let aborted = false;
  await page.route("http://stub.pqp.test/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: STUB_CORS });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    await route.abort().catch(() => undefined);
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("http://stub.pqp.test/")) aborted = true;
  });

  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer);
  await discardComposer(page, composer);
  await expect.poll(() => requests.list.includes("DELETE /api/stories/uploads/00000000-0000-4000-8000-0000000000a2")).toBe(true);
  await expect.poll(() => aborted).toBe(true);
});

// ------------------------------------------------------------------ with real storage

test("real storage: Post closes the composer at once, the ring takes over, the story goes live in one request", async ({ page }) => {
  const ctx = await setup();
  test.skip(!ctx.storage || !s3(), "object storage is off: no uploads to watch");
  const requests = recordRequests(page, /^\/api\/stories(\/|$)/);
  const minted = page.waitForResponse((response) => response.url().endsWith("/api/stories/uploads") && response.request().method() === "POST");
  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer, 200);
  const upload = (await (await minted).json()) as { url: string };
  // The file is in the bucket before Post is pressed.
  await expect.poll(() => objectExists(upload.url), { timeout: 20_000 }).toBe(true);

  const t0 = Date.now();
  await realClick(page, composer.locator("[data-story-post]"), "Post");
  await expect(composer).toHaveCount(0, { timeout: 1500 });
  expect(Date.now() - t0).toBeLessThan(1500);
  await expect(ownRing(page, ctx)).toBeVisible();
  await expect.poll(() => ownStoryIds(ctx), { timeout: 30_000 }).toHaveLength(1);

  const create = requests.bodies.find((body) => (body as { kind?: string } | null)?.kind === "image") as {
    media: { uploadId?: string };
    publish?: boolean;
  };
  expect(create.media.uploadId).toBeTruthy();
  expect(create.publish).toBe(true);
  expect(requests.list.filter((entry) => entry.endsWith("/publish"))).toEqual([]);
});

test("real storage: a draft discarded after its upload finished deletes the object", async ({ page }) => {
  const ctx = await setup();
  test.skip(!ctx.storage || !s3(), "object storage is off: no uploads to watch");
  const minted = page.waitForResponse((response) => response.url().endsWith("/api/stories/uploads") && response.request().method() === "POST");
  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer);
  const upload = (await (await minted).json()) as { uploadId: string; url: string };
  await expect.poll(() => objectExists(upload.url), { timeout: 20_000, message: "the file is in the bucket before Post" }).toBe(true);

  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/stories/uploads/${upload.uploadId}`) && response.request().method() === "DELETE");
  await discardComposer(page, composer);
  expect((await deleted).status()).toBe(204);
  await expect.poll(() => objectExists(upload.url), { timeout: 10_000 }).toBe(false);
  expect(await ownStoryIds(ctx)).toEqual([]);
});

test("real storage: discarding in the middle of an upload aborts it and nothing is left in the bucket", async ({ page }) => {
  const ctx = await setup();
  test.skip(!ctx.storage || !s3(), "object storage is off: no uploads to watch");
  const minted = page.waitForResponse((response) => response.url().endsWith("/api/stories/uploads") && response.request().method() === "POST");
  const composer = await openComposer(page, ctx);
  // A slow uplink (about 40 KB/s): a 1.5 MB photo is still going up when the author gives up.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 100, downloadThroughput: -1, uploadThroughput: 40 * 1024 });
  await composer.locator("[data-story-file]").setInputFiles(await noisePhoto(page, 1500));
  await expect(composer.locator("[data-story-post]")).toBeEnabled({ timeout: 30_000 });
  const upload = (await (await minted).json()) as { uploadId: string; url: string };
  await page.waitForTimeout(1500);
  expect(await objectExists(upload.url), "still going up").toBe(false);

  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/stories/uploads/${upload.uploadId}`) && response.request().method() === "DELETE");
  await discardComposer(page, composer);
  expect((await deleted).status()).toBe(204);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // Whatever the storage had begun receiving is not an object.
  await page.waitForTimeout(1500);
  expect(await objectExists(upload.url)).toBe(false);
});

test("real storage: taking a placed photo off the story deletes its upload", async ({ page }) => {
  const ctx = await setup();
  test.skip(!ctx.storage || !s3(), "object storage is off: no uploads to watch");
  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer);
  const minted = page.waitForResponse((response) => response.url().endsWith("/api/stories/uploads") && response.request().method() === "POST");
  await composer.locator("[data-story-photo-file]").setInputFiles(await noisePhoto(page, 60));
  await expect(composer.locator('[data-layer-type="image"]')).toHaveCount(1, { timeout: 20_000 });
  const layerUpload = (await (await minted).json()) as { uploadId: string; url: string };
  await expect.poll(() => objectExists(layerUpload.url), { timeout: 20_000 }).toBe(true);

  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/stories/uploads/${layerUpload.uploadId}`) && response.request().method() === "DELETE");
  await composer.locator('[data-layer-type="image"]').first().click();
  await realClick(page, composer.locator("[data-story-delete]"), "delete layer");
  expect((await deleted).status()).toBe(204);
  await expect.poll(() => objectExists(layerUpload.url), { timeout: 10_000 }).toBe(false);
});

test("real storage: offline while posting waits (No connection, grey), posts by itself when back online, and Discard stays possible", async ({ page }) => {
  const ctx = await setup();
  test.skip(!ctx.storage || !s3(), "object storage is off: no uploads to watch");
  const composer = await openComposer(page, ctx);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await attachPhoto(page, composer);
  // The connection drops before Post: the upload (done or not) cannot be confirmed, and the create cannot go.
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await realClick(page, composer.locator("[data-story-post]"), "Post");
  await expect(composer).toHaveCount(0, { timeout: 1500 });

  const ring = ownRing(page, ctx);
  await expect(ring).toBeVisible();
  // Not a failure: a waiting state with the connection named, never the red "Didn't post".
  await expect(strip(page, ctx)).toContainText("Offline", { timeout: 30_000 });
  await expect(page.getByText("Didn't post")).toHaveCount(0);
  // The ring still offers Try again (now) and Discard; nothing was thrown away.
  await realClick(page, ring, "waiting ring");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Try again" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Discard" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Back online: it posts by itself, no tap.
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect.poll(() => ownStoryIds(ctx), { timeout: 40_000 }).toHaveLength(1);
});

test("real storage: Discard on a failed ring clears it, deletes the upload and posts nothing", async ({ page }) => {
  const ctx = await setup();
  test.skip(!ctx.storage || !s3(), "object storage is off: no uploads to watch");
  // The create is refused by the network, so the post fails with the file already stored.
  await page.route("**/api/stories", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
  const minted = page.waitForResponse((response) => response.url().endsWith("/api/stories/uploads") && response.request().method() === "POST");
  const composer = await openComposer(page, ctx);
  await attachPhoto(page, composer);
  const upload = (await (await minted).json()) as { uploadId: string; url: string };
  await expect.poll(() => objectExists(upload.url), { timeout: 20_000 }).toBe(true);
  await realClick(page, composer.locator("[data-story-post]"), "Post");
  await expect(composer).toHaveCount(0, { timeout: 1500 });
  const ring = ownRing(page, ctx);
  await expect(strip(page, ctx)).toContainText("Didn't post", { timeout: 20_000 });
  // The draft survives the failure: its upload is still in the bucket.
  expect(await objectExists(upload.url)).toBe(true);

  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/stories/uploads/${upload.uploadId}`) && response.request().method() === "DELETE");
  await realClick(page, ring, "failed ring");
  await page.getByRole("menuitem", { name: "Discard" }).click();
  expect((await deleted).status()).toBe(204);
  // With nothing live the strip draws nothing at all once the failed post is gone.
  await expect(page.getByText("Didn't post")).toHaveCount(0);
  await expect.poll(() => objectExists(upload.url), { timeout: 10_000 }).toBe(false);
  expect(await ownStoryIds(ctx)).toEqual([]);
});
