import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Baú (Community Home), end to end against the real API.
 *
 * The suite's API runs with `COMMUNITY_HOME_ENABLED=true` and
 * `COMMUNITY_HOME_VIP_ENABLED=true` (see playwright.config.ts). The flag-off
 * chrome is proved with the dev-bypass override `?communityHome=0`, which is
 * the same switch a local run uses, and the flag-off *API* is pinned in
 * `server/src/services/community-home.test.ts`.
 *
 * Row: flag on shows Baú on any server (including private halls).
 * Landing: flag on + isCommunity lands on Baú; private halls still land on
 * the first text channel.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const OWNER = "home-owner";
const MEMBER = "home-member";

test.setTimeout(90_000);

function headers(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}${suffix ? `:${suffix}` : ""}`,
  };
}

async function ensureAccount(suffix?: string): Promise<void> {
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

async function seedCommunity(name: string): Promise<string> {
  await ensureAccount(OWNER);
  await ensureAccount(MEMBER);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    throw new Error(`could not create ${name}: ${created.status}`);
  }
  const { server } = (await created.json()) as { server: { id: string } };

  const invite = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({}),
  });
  const { invite: made } = (await invite.json()) as {
    invite: { code: string };
  };
  await fetch(`${API}/api/invites/${made.code}/join`, {
    method: "POST",
    headers: headers(MEMBER),
  });

  const patched = await fetch(`${API}/api/servers/${server.id}/community`, {
    method: "PATCH",
    headers: headers(OWNER),
    body: JSON.stringify({
      isCommunity: true,
      category: "games",
      tagline: "RPG às terças. mapa na tela.",
    }),
  });
  if (!patched.ok) {
    const detail = await patched.text().catch(() => "");
    throw new Error(
      `could not list ${name}: ${patched.status} ${detail.slice(0, 200)}`,
    );
  }
  return server.id;
}

async function seedPost(
  serverId: string,
  post: {
    title: string;
    body: string;
    visibility?: "free" | "members";
    teaser?: string;
    youtubeUrl?: string;
  },
): Promise<string> {
  const res = await fetch(`${API}/api/servers/${serverId}/home/posts`, {
    method: "POST",
    headers: headers(OWNER),
    body: JSON.stringify({ status: "published", ...post }),
  });
  if (!res.ok) {
    throw new Error(`could not seed post: ${res.status} ${await res.text()}`);
  }
  const { post: created } = (await res.json()) as { post: { id: string } };
  return created.id;
}

async function seedComment(serverId: string, postId: string, body: string) {
  const res = await fetch(
    `${API}/api/servers/${serverId}/home/posts/${postId}/comments`,
    { method: "POST", headers: headers(MEMBER), body: JSON.stringify({ body }) },
  );
  if (!res.ok) {
    throw new Error(`could not seed comment: ${res.status}`);
  }
}

async function openAs(
  page: Page,
  suffix: string,
  serverId: string,
  query: Record<string, string> = {},
): Promise<void> {
  await page.addInitScript((who) => {
    localStorage.setItem("pqp:dev-user-suffix", who);
  }, suffix);
  const params = new URLSearchParams({ lang: "en", ...query });
  await page.goto(`/app/server/${serverId}?${params.toString()}`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Baú", () => {
  test("forced off: no Baú row on a community server, lands on text", async ({
    page,
  }) => {
    const serverId = await seedCommunity(`Home Off ${Date.now()}`);
    await openAs(page, OWNER, serverId, { communityHome: "0" });
    await expect(page.locator("[data-community-home-row]")).toHaveCount(0);
    await expect(page.locator("[data-community-home-feed]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("owner: community lands on Baú, empty guide, write + preview + publish", async ({
    page,
  }) => {
    const serverId = await seedCommunity(`Mesa Home ${Date.now()}`);
    await openAs(page, OWNER, serverId, { communityHome: "1" });

    await expect(page.locator("[data-community-home-row]")).toBeVisible({
      timeout: 20_000,
    });
    const feed = page.locator("[data-community-home-feed]");
    await expect(feed).toBeVisible({ timeout: 20_000 });

    // Empty Baú: the owner gets the guide, not a blank pane.
    await expect(feed.locator('[data-home-staff-guide="empty"]')).toBeVisible();
    await feed.locator("[data-home-guide-compose]").click();
    await expect(feed.locator("[data-home-compose]")).toBeVisible();

    // Preview before publishing.
    await feed.locator("[data-home-compose-title]").fill("Sessão de e2e");
    await feed.locator("[data-home-compose-body]").fill("post de e2e na mesa");
    await feed.locator("[data-home-compose-preview-toggle]").click();
    const preview = feed.locator("[data-home-compose-preview]");
    await expect(preview).toBeVisible();
    await expect(preview.getByText("post de e2e na mesa")).toBeVisible();

    // Publish, land back on the feed with the post at the top.
    await feed.locator("[data-home-compose-submit]").click();
    await expect(feed.locator("[data-home-notice]")).toBeVisible();
    const card = feed.locator("[data-home-post]").first();
    await expect(card.getByText("Sessão de e2e")).toBeVisible();
    // No "free" chip on a free post.
    await expect(card.locator("[data-home-vip-chip]")).toHaveCount(0);

    // Like it.
    await card.locator("[data-home-like]").click();
    await expect(card.locator("[data-home-like]")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("member: intro card once, teaser comments, VIP lock, no compose", async ({
    page,
  }) => {
    const serverId = await seedCommunity(`Mesa Member ${Date.now()}`);
    const freeId = await seedPost(serverId, {
      title: "Mapa do porão",
      body: "mapa-porao.png fica aqui",
    });
    await seedComment(serverId, freeId, "primeiro comentário");
    await seedComment(serverId, freeId, "segundo comentário");
    await seedComment(serverId, freeId, "terceiro comentário");
    await seedPost(serverId, {
      title: "Sessão 11, o clip",
      body: "o clip inteiro está aqui: sessao-11-clip.webm",
      visibility: "members",
      teaser: "só o inner vê o clip",
    });

    await openAs(page, MEMBER, serverId, { communityHome: "1" });
    const feed = page.locator("[data-community-home-feed]");
    await expect(feed).toBeVisible({ timeout: 20_000 });

    // No staff chrome for a plain member.
    await expect(feed.locator("[data-home-staff-tabs]")).toHaveCount(0);
    await expect(feed.locator("[data-home-compose]")).toHaveCount(0);

    // Intro card, dismissed for good.
    await expect(feed.locator("[data-home-intro]")).toBeVisible();
    await feed.locator("[data-home-intro-dismiss]").click();
    await expect(feed.locator("[data-home-intro]")).toHaveCount(0);

    // Locked VIP post: title + teaser, nothing else, CTA disabled.
    const locked = feed.locator('[data-home-post][data-home-post-locked="1"]');
    await expect(locked).toBeVisible();
    await expect(locked.getByText("só o inner vê o clip")).toBeVisible();
    await expect(locked.locator("[data-home-unlock-cta]")).toBeDisabled();
    await expect(feed).not.toContainText("sessao-11-clip.webm");

    // Comments: two newest in the card, the rest on demand.
    const open = feed.locator("[data-home-post]").filter({
      hasText: "Mapa do porão",
    });
    await expect(open.locator("[data-home-comment]")).toHaveCount(2);
    await open.locator("[data-home-comments-toggle]").click();
    await expect(open.locator("[data-home-comment]")).toHaveCount(3);

    // Reload: the intro stays dismissed (it is a preference, not a tab).
    await page.reload();
    await expect(feed).toBeVisible({ timeout: 20_000 });
    await expect(feed.locator("[data-home-intro]")).toHaveCount(0);
  });

  test("private server: Baú row shows but landing stays on text", async ({
    page,
  }) => {
    // openApp seeds a plain "E2E" server that is not a community.
    await openApp(page);
    await page.goto("/app?lang=en&communityHome=1");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-community-home-row]")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-community-home-feed]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
  });
});
