import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";

/**
 * Baú automatic translation, the reader's half, through the real pipeline.
 *
 * Nothing here is mocked in the browser or in the API. The suite's API runs
 * with a fake `OPENROUTER_API_KEY` and `COMMUNITY_HOME_TRANSLATION_BASE_URL`
 * pointing at the tiny OpenAI-compatible endpoint this file serves, so a post
 * published in Portuguese is translated by the real job (claim, budget, hash,
 * stored row) with no network. The runtime flag `community_home_translation`
 * is flipped for THIS server only, through the machine token, the way the
 * dashboard does it.
 *
 *  1. an English reader sees the English text and one quiet line that says
 *     so; "See original" flips that post, and the choice survives a reload;
 *  2. a Portuguese reader of a Portuguese post sees no line at all;
 *  3. on a phone the line fits and flipping it does not move the line;
 *  4. staff see the note in the composer and the per-language read-only list.
 *
 * What a members-only post may and may not leak through a translation is
 * pinned in `server/src/services/community-home-translation.test.ts`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
/** `ADMIN_METRICS_TOKEN` of the suite's server, see `playwright.config.ts`. */
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";
/**
 * Where `playwright.config.ts` points the API's translation calls. The config
 * writes the resolved port into the environment; the fallback repeats its
 * rule (server port plus 98) for a run that bypasses it.
 */
const STUB_PORT = Number(
  process.env.E2E_TRANSLATION_STUB_PORT ??
    Number(process.env.E2E_SERVER_PORT ?? 3101) + 98,
);
const STAMP = Date.now().toString(36);
const OWNER = `tr-owner-${STAMP}`;
const READER = `tr-reader-${STAMP}`;

const PT_TITLE = "Novidade no Baú do QG";
const PT_BODY =
  "Agora o Baú traduz os posts sozinho, então você escreve no seu idioma e a galera lê no deles.";

const EN: Record<string, string> = {
  [PT_TITLE]: "News in the QG's Baú",
  [PT_BODY]:
    "The Baú now translates posts on its own, so you write in your language and everybody reads in theirs.",
};
const ES: Record<string, string> = {
  [PT_TITLE]: "Novedad en el Baú del QG",
  [PT_BODY]:
    "El Baú ahora traduce los posts solo, así que escribes en tu idioma y la gente lee en el suyo.",
};

test.setTimeout(90_000);
test.describe.configure({ mode: "serial" });

function headers(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}${suffix ? `:${suffix}` : ""}`,
  };
}

/** A minimal OpenAI-compatible chat endpoint: answers each JSON array of strings with its translation. */
let stub: Server | null = null;

test.beforeAll(async () => {
  stub = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let texts: string[] = [];
      let into = "English";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages: Array<{ role: string; content: string }>;
        };
        texts = JSON.parse(body.messages.find((m) => m.role === "user")!.content);
        into = /into ([^.\n]+)\./.exec(body.messages[0]!.content)?.[1] ?? into;
      } catch {
        res.statusCode = 400;
        res.end("bad request");
        return;
      }
      const table = into.startsWith("Spanish") ? ES : EN;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(texts.map((t) => table[t] ?? t)) } }],
          usage: { cost: 0 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    // Another worker of this run may already be serving the same stub: fine.
    stub!.once("error", () => resolve());
    stub!.listen(STUB_PORT, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!stub?.listening) return resolve();
    stub.close(() => resolve());
  });
});

async function ensureAccount(suffix: string): Promise<void> {
  const me = await fetch(`${API}/api/me`, { headers: headers(suffix) });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers: headers(suffix),
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
}

async function seedCommunityWithTranslatedPost(): Promise<{ serverId: string; postId: string }> {
  await ensureAccount(OWNER);
  await ensureAccount(READER);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({ name: `QG Traducao ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const invite = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({}),
  });
  const { invite: made } = (await invite.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${made.code}/join`, { method: "POST", headers: headers(READER) });
  const opted = await fetch(`${API}/api/servers/${server.id}/home/config`, {
    method: "PATCH",
    headers: headers(OWNER),
    body: JSON.stringify({ enabled: true }),
  });
  expect(opted.ok).toBe(true);

  // The flag, for this server only, the way the dashboard turns it on.
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({
      key: "community_home_translation",
      serverId: server.id,
      enabled: true,
    }),
  });
  expect(flip.ok).toBe(true);

  const res = await fetch(`${API}/api/servers/${server.id}/home/posts`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({ status: "published", title: PT_TITLE, body: PT_BODY }),
  });
  expect(res.status).toBe(201);
  const { post } = (await res.json()) as { post: { id: string } };

  // Wait for the real job to finish both languages.
  await expect
    .poll(
      async () => {
        const out: boolean[] = [];
        for (const lang of ["en", "es"]) {
          const feed = await fetch(`${API}/api/servers/${server.id}/home/posts?lang=${lang}`, {
            headers: headers(READER),
          });
          const { posts } = (await feed.json()) as { posts: Array<{ translation: unknown }> };
          out.push(Boolean(posts[0]?.translation));
        }
        return out;
      },
      { timeout: 30_000 },
    )
    .toEqual([true, true]);
  return { serverId: server.id, postId: post.id };
}

async function openAs(page: Page, suffix: string, serverId: string, lang: string): Promise<void> {
  await page.addInitScript((who) => {
    localStorage.setItem("pqp:dev-user-suffix", who);
  }, suffix);
  await page.goto(`/app/server/${serverId}?lang=${lang}&communityHome=1`);
  await expect(page.locator("[data-community-home-feed]")).toBeVisible({ timeout: 20_000 });
}

test.describe("Baú translation", () => {
  let serverId = "";

  test.beforeAll(async () => {
    ({ serverId } = await seedCommunityWithTranslatedPost());
  });

  test("an English reader gets the translation, can flip to the original, and it sticks for the session", async ({
    page,
  }) => {
    await openAs(page, READER, serverId, "en");
    const card = page.locator("[data-home-post]").first();
    await expect(card.getByRole("heading", { name: EN[PT_TITLE]! })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText(EN[PT_BODY]!)).toBeVisible();
    await expect(card.getByText(PT_BODY)).toHaveCount(0);
    const note = card.locator("[data-home-translation-note]");
    await expect(note).toContainText("Automatically translated");

    await card.locator("[data-home-translation-toggle]").click();
    await expect(card.getByRole("heading", { name: PT_TITLE })).toBeVisible();
    await expect(card.getByText(PT_BODY)).toBeVisible();
    await expect(note).toContainText("Original text");
    await expect(card.locator("[data-home-translation-toggle]")).toHaveText("See translation");

    // Remembered for the session: a reload still shows this post's original.
    await page.reload();
    const again = page.locator("[data-home-post]").first();
    await expect(again.getByText(PT_BODY)).toBeVisible({ timeout: 20_000 });
    await again.locator("[data-home-translation-toggle]").click();
    await expect(again.getByText(EN[PT_BODY]!)).toBeVisible();
  });

  test("a Spanish reader gets Spanish, and the line speaks Spanish", async ({ page }) => {
    await openAs(page, READER, serverId, "es");
    const card = page.locator("[data-home-post]").first();
    await expect(card.getByText(ES[PT_BODY]!)).toBeVisible({ timeout: 20_000 });
    await expect(card.locator("[data-home-translation-note]")).toContainText("Traducido automáticamente");
  });

  test("a Portuguese reader of a Portuguese post sees the post and no line at all", async ({ page }) => {
    await openAs(page, READER, serverId, "pt-BR");
    const card = page.locator("[data-home-post]").first();
    await expect(card.getByText(PT_BODY)).toBeVisible({ timeout: 20_000 });
    await expect(card.locator("[data-home-translation-note]")).toHaveCount(0);
  });

  test("on a phone the line fits and flipping it does not move it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAs(page, READER, serverId, "en");
    const card = page.locator("[data-home-post]").first();
    const note = card.locator("[data-home-translation-note]");
    await expect(note).toBeVisible({ timeout: 20_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await note.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(24);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await note.locator("[data-home-translation-toggle]").click();
    const after = await note.boundingBox();
    expect(Math.abs(after!.height - box!.height)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("translation-phone.png") });
  });

  test("staff are told readers see a translation, and can read each language", async ({ page }) => {
    await openAs(page, OWNER, serverId, "en");
    const feed = page.locator("[data-community-home-feed]");
    // Staff reading in English also get the translated card, with the line.
    const card = feed.locator("[data-home-post]").first();
    await expect(card.locator("[data-home-translation-note]")).toBeVisible({ timeout: 20_000 });

    // Editing a post edits the author's words, never the translation.
    await card.locator("[data-home-card-menu]").click();
    await card.locator("[data-home-edit]").click();
    await expect(feed.locator("[data-home-compose-title]")).toHaveValue(PT_TITLE);
    await expect(feed.locator("[data-home-compose-body]")).toHaveValue(PT_BODY);

    const note = feed.locator("[data-home-compose-translation]");
    await expect(note).toContainText("Readers in other languages will see an automatic translation");
    await note.locator("[data-home-compose-translation-toggle]").click();
    const rows = note.locator("[data-home-translation-rows]");
    await expect(rows.locator('[data-home-translation-row="en"]')).toContainText(EN[PT_BODY]!);
    await expect(rows.locator('[data-home-translation-row="es"]')).toContainText(ES[PT_BODY]!);
    await expect(rows.locator('[data-home-translation-row="pt"]')).toContainText("Already in this language");
    await page.screenshot({ path: test.info().outputPath("translation-staff.png") });
  });
});
