import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * Baú+: a fan pays a creator for VIP with Pix, against the built-in SANDBOX
 * provider (no real money, no real provider). The suite's API runs with the dev
 * auth bypass, so the sandbox is the provider, and with
 * `BAU_PAYMENTS_SANDBOX_AUTOPAY_SECONDS=0`, so a payment lands only when the
 * spec presses the sandbox's own button (which sends a real webhook through the
 * same handler a provider would reach).
 *
 * The flag is set the way production sets it: the per-server `bau_payments`
 * override through the operator's machine token, never an env var.
 *
 * Asserted on data attributes and roles, so the copy can move without this
 * file following it.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const STAMP = Date.now().toString(36);
const OWNER = `pay-owner-${STAMP}`;
const FAN = `pay-fan-${STAMP}`;

test.setTimeout(120_000);

function headers(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function call(suffix: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function ensureAccount(suffix: string): Promise<void> {
  const me = (await call(suffix, "GET", "/api/me")) as { ageGate?: string };
  if (me.ageGate !== "passed") {
    await call(suffix, "POST", "/api/me/age-check", { dateOfBirth: "1990-01-01" });
  }
  await call(suffix, "PATCH", "/api/me/preferences", {
    onboardedAt: new Date().toISOString(),
    firstRunDismissedAt: new Date().toISOString(),
    communityHomeIntroDismissedAt: new Date().toISOString(),
  });
}

/** A hall with the Baú on, a VIP post, a plan and a sandbox payout account. */
async function seedCreator(): Promise<{ serverId: string; postId: string }> {
  await ensureAccount(OWNER);
  await ensureAccount(FAN);
  const { server } = (await call(OWNER, "POST", "/api/servers", {
    name: `Canal Pago ${STAMP}`,
  })) as { server: { id: string } };
  const { invite } = (await call(OWNER, "POST", `/api/servers/${server.id}/invites`, {})) as {
    invite: { code: string };
  };
  await call(FAN, "POST", `/api/invites/${invite.code}/join`);
  await call(OWNER, "PATCH", `/api/servers/${server.id}/home/config`, { enabled: true });
  const { post } = (await call(OWNER, "POST", `/api/servers/${server.id}/home/posts`, {
    status: "published",
    visibility: "members",
    title: "Bastidores",
    teaser: "O roteiro inteiro e as cenas cortadas.",
    body: "O texto que só VIP lê.",
  })) as { post: { id: string } };
  await call(OWNER, "PUT", `/api/servers/${server.id}/bau-plus/plan`, {
    name: "VIP",
    priceCents: 990,
    perks: ["Os posts VIP inteiros"],
  });
  await call(OWNER, "POST", `/api/servers/${server.id}/bau-plus/sandbox/connect`, {
    sellerName: "Bia Souza",
  });
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "bau_payments", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  return { serverId: server.id, postId: post.id };
}

async function openAsFan(page: Page, serverId: string): Promise<void> {
  await page.addInitScript((who) => {
    localStorage.setItem("pqp:dev-user-suffix", who);
  }, FAN);
  await page.goto(`/app/server/${serverId}/bau?lang=en&communityHome=1`);
  await expect(page.locator("[data-community-home-feed]")).toBeVisible({ timeout: 30_000 });
}

test.describe("Baú+ pay flow (sandbox)", () => {
  test("locked post, Pix, confirmed, unlocked, then refunded and locked again", async ({ page }) => {
    const { serverId, postId } = await seedCreator();
    await openAsFan(page, serverId);

    const post = page.locator(`[data-home-post-id="${postId}"]`);
    await expect(post).toHaveAttribute("data-home-post-locked", "1");
    const cta = post.locator("[data-bau-paywall-cta]");
    await expect(cta).toBeEnabled();
    await expect(cta).toContainText("9.90");
    await cta.click();

    const sheet = page.locator("[data-bau-pay]");
    await expect(sheet).toHaveAttribute("data-bau-step", "summary");
    await expect(sheet.locator("[data-bau-seller]")).toContainText("Bia Souza");
    await sheet.locator("[data-bau-start]").click();

    await expect(sheet.locator("[data-bau-qr]")).toBeVisible();
    await expect(sheet.locator("[data-bau-countdown]")).toBeVisible();
    await expect(sheet.locator("[data-bau-pix-code]")).toContainText("BR.GOV.BCB.PIX");

    // The sandbox pays and sends its webhook; the sheet flips on its own.
    await sheet.locator('[data-bau-sandbox-action="pay"]').click();
    await expect(sheet.locator("[data-bau-paid]")).toBeVisible({ timeout: 15_000 });
    await sheet.locator("[data-bau-paid-continue]").click();

    await expect(post).toHaveAttribute("data-home-post-locked", "0", { timeout: 15_000 });
    await expect(post.locator("[data-home-vip-chip]")).toBeVisible();
    await expect(page.locator('[data-bau-strip="welcome"]')).toBeVisible();

    // The manager, the receipt and the 7-day refund.
    await page.getByRole("button", { name: "Open settings" }).first().click();
    await page.getByRole("tab", { name: "Memberships", exact: true }).click();
    const card = page.locator("[data-bau-membership]");
    await expect(card).toHaveAttribute("data-bau-membership", "active");
    await expect(card.locator("[data-bau-receipt]")).toHaveCount(1);
    await card.locator("[data-bau-refund]").click();
    await page.getByRole("button", { name: "Ask for a refund", exact: true }).click();
    await expect(card).toHaveAttribute("data-bau-membership", "refunded", { timeout: 15_000 });

    await page.keyboard.press("Escape");
    await expect(post).toHaveAttribute("data-home-post-locked", "1", { timeout: 15_000 });
  });

  test("an expired code offers a new one, and a declined card offers Pix", async ({ page }) => {
    const { serverId, postId } = await seedCreator();
    await openAsFan(page, serverId);
    await page.locator(`[data-home-post-id="${postId}"] [data-bau-paywall-cta]`).click();
    const sheet = page.locator("[data-bau-pay]");
    await sheet.locator("[data-bau-start]").click();

    await sheet.locator('[data-bau-sandbox-action="expire"]').click();
    await expect(sheet.locator("[data-bau-expired]")).toBeVisible();
    await sheet.locator("[data-bau-check-late]").click();
    await expect(sheet.locator("[data-bau-late-note]")).toBeVisible();

    await sheet.locator("[data-bau-back]").click();
    await sheet.getByRole("radio", { name: "Card" }).click();
    await sheet.locator("[data-bau-start]").click();
    await sheet.locator('[data-bau-sandbox-action="fail"]').click();
    await expect(sheet.locator("[data-bau-declined]")).toBeVisible();
    await sheet.getByRole("button", { name: "Pay with Pix" }).click();
    await expect(sheet.locator("[data-bau-qr]")).toBeVisible();
  });
});
