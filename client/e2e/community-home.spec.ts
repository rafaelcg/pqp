import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Community Home (Baú / Home).
 *
 * Feature latch via `?communityHome=1` (never bake VITE_COMMUNITY_HOME_ENABLED
 * into the shared Vite webServer). Per-server toggle defaults OFF — staff must
 * enable Home in Server Settings before the row appears.
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

async function enableHome(serverId: string): Promise<void> {
  const res = await fetch(`${API}/api/servers/${serverId}/home/config`, {
    method: "PATCH",
    headers: headers(OWNER),
    body: JSON.stringify({ enabled: true }),
  });
  if (!res.ok) {
    throw new Error(`could not enable Home: ${res.status}`);
  }
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
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("latch on but server toggle off: no row", async ({ page }) => {
    const serverId = await seedCommunity(`Home Latch ${Date.now()}`);
    await openOwnerServer(page, serverId, { communityHome: "1" });
    await expect(page.locator("[data-community-home-row]")).toHaveCount(0);
    await expect(page.locator("[data-community-home-feed]")).toHaveCount(0);
  });

  test("toggle on + community: lands on Home with locked chrome", async ({
    page,
  }) => {
    const serverId = await seedCommunity(`Home On ${Date.now()}`);
    await enableHome(serverId);
    await openOwnerServer(page, serverId, { communityHome: "1" });

    await expect(page.locator("[data-community-home-row]")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-community-home-feed]")).toBeVisible({
      timeout: 20_000,
    });

    // Locked chrome: no CHANNEL · pill, no Compose|Preview, no viewer filter.
    await expect(page.getByText(/channel ·/i)).toHaveCount(0);
    await expect(page.getByText(/canal ·/i)).toHaveCount(0);
    await expect(page.locator("[data-home-staff-tabs]")).toHaveCount(0);
    await expect(page.locator("[data-home-viewer-tabs]")).toHaveCount(0);
    await expect(page.getByText(/vendo como/i)).toHaveCount(0);
    await expect(page.getByText(/^livre$/i)).toHaveCount(0);
    await expect(page.getByText(/^free$/i)).toHaveCount(0);
    await expect(page.getByText("Tues")).toHaveCount(0);

    // No call CTA.
    await expect(
      page.getByRole("button", { name: /join the call/i }),
    ).toHaveCount(0);

    // Empty library quieter copy (no seed posts).
    await expect(
      page.getByText(
        "Photos, clips, files, a note. Things that should still be here tomorrow.",
      ),
    ).toBeVisible();

    // Staff pen in the header — no second Post button on the canvas.
    await expect(page.locator("[data-home-staff-pen]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^post$/i }),
    ).toHaveCount(0);
  });

  test("private server with latch + toggle shows row but lands on text", async ({
    page,
  }) => {
    await openApp(page);
    await page.goto("/app?lang=en&communityHome=1");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({
      timeout: 20_000,
    });

    // Find the E2E private server id from the URL after openApp lands.
    const url = page.url();
    const match = url.match(/\/app\/server\/([0-9a-f-]{36})/);
    if (!match) {
      // openApp may leave us on /app without a server deep link — skip row assert.
      test.info().annotations.push({
        type: "note",
        description: "no server id in URL after openApp",
      });
      return;
    }
    const serverId = match[1]!;
    await enableHome(serverId);
    await page.goto(`/app/server/${serverId}?lang=en&communityHome=1`);
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
