import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Community Home (client-only mock).
 *
 * Enabled in this suite via `?communityHome=1` (sticky latch), never by baking
 * `VITE_COMMUNITY_HOME_ENABLED` into the shared Vite webServer — that would
 * turn the surface on for every other e2e that shares the process.
 *
 * Needs a listed community: Home only appears / lands on `isCommunity` servers.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const OWNER = "home-owner";

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
  await ensureAccount("home-filler");
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
    headers: headers("home-filler"),
  });

  const patched = await fetch(`${API}/api/servers/${server.id}/community`, {
    method: "PATCH",
    headers: headers(OWNER),
    body: JSON.stringify({
      isCommunity: true,
      category: "gaming",
      tagline: "RPG às terças. mapa na tela.",
    }),
  });
  if (!patched.ok) {
    throw new Error(`could not list ${name}: ${patched.status}`);
  }
  return server.id;
}

async function openOwnerServer(
  page: Page,
  serverId: string,
  query: Record<string, string> = {},
): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("pqp:dev-user-suffix", "home-owner");
  });
  const params = new URLSearchParams({ lang: "en", ...query });
  await page.goto(`/app/server/${serverId}?${params.toString()}`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
}

test.describe("Community Home", () => {
  test("flag off: no Home row on a community server", async ({ page }) => {
    const serverId = await seedCommunity(`Home Off ${Date.now()}`);
    await openOwnerServer(page, serverId);
    await expect(page.locator("[data-community-home-row]")).toHaveCount(0);
    await expect(page.locator("[data-community-home-feed]")).toHaveCount(0);
    // Lands on a real text channel instead.
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("flag on: community lands on Home, lock + compose/preview + comments", async ({
    page,
  }) => {
    const serverId = await seedCommunity(`Mesa Home ${Date.now()}`);
    await openOwnerServer(page, serverId, {
      communityHome: "1",
      homeViewer: "free",
    });

    await expect(page.locator("[data-community-home-row]")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-community-home-feed]")).toBeVisible({
      timeout: 20_000,
    });

    // No call CTA anywhere on Home.
    await expect(
      page.getByRole("button", { name: /join the call/i }),
    ).toHaveCount(0);
    await expect(page.getByText(/entrar na call/i)).toHaveCount(0);

    // Locked VIP post: unlock CTA present, media path locked, no clip filename.
    await expect(page.locator("[data-home-locked-media]")).toBeVisible();
    await expect(page.locator("[data-home-unlock-cta]")).toBeDisabled();
    await expect(page.locator("[data-community-home-feed]")).not.toContainText(
      "sessao-11-clip.webm",
    );

    // Staff CMS: Compose | Preview. Composer stays reachable while Preview
    // viewer tabs are used.
    await expect(page.locator("[data-home-staff-tabs]")).toBeVisible();
    await page.locator('[data-home-staff-tab="preview"]').click();
    await expect(page.locator("[data-home-viewer-tabs]")).toBeVisible();
    await page.locator('[data-home-viewer-tab="free"]').click();
    await expect(page.locator("[data-home-locked-media]")).toBeVisible();
    await page.locator('[data-home-staff-tab="compose"]').click();
    await expect(page.locator("[data-home-compose]")).toBeVisible();
    await expect(page.locator("[data-home-compose-body]")).toBeVisible();

    // Publish a free text post as the signed-in owner (not hardcoded Tues).
    await page.locator("[data-home-compose-body]").fill("post de e2e na mesa");
    await page.locator("[data-home-compose-submit]").click();
    await page.locator('[data-home-staff-tab="preview"]').click();
    await expect(page.getByText("post de e2e na mesa")).toBeVisible();
    await expect(page.getByText("Dev User home-owner")).toBeVisible();

    // Comments flat list on a published seed post.
    const commentsToggle = page.locator("[data-home-comments-toggle]").first();
    await commentsToggle.click();
    await expect(page.locator("[data-home-comment]").first()).toBeVisible();
  });

  test("private (non-community) server does not show Home even with latch", async ({
    page,
  }) => {
    // openApp seeds a plain "E2E" server that is not a community.
    await openApp(page);
    await page.goto("/app?lang=en&communityHome=1");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-community-home-row]")).toHaveCount(0);
    await expect(page.locator("[data-community-home-feed]")).toHaveCount(0);
  });
});
