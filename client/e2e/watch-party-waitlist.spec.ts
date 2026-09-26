import { expect, test, type Page } from "@playwright/test";

/**
 * The watch party waitlist, in a browser, on a real server and a real socket.
 *
 * WHAT IS REAL. The server answers `enabled: false` for these servers because
 * CI has no LiveKit and no bucket, which is exactly the shape of a server the
 * operator has not turned on, so nothing about the config is stubbed. The
 * campaign itself is on because `playwright.config.ts` sets
 * `WATCH_PARTY_WAITLIST=on` for the suite's server (with no watch parties on
 * the deployment it would follow `LIVE_HLS_ENABLED` and be off). The build
 * flag comes from `?watchParty=1`, the documented dev-bypass override.
 *
 * Every test mints its own accounts and its own server, so a row left by a
 * previous run cannot turn a "join" into an "already on the list".
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialise(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
}

async function seed(owner: string, member?: string): Promise<string> {
  await materialise(owner);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(owner),
    body: JSON.stringify({ name: `Fila ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  if (member) {
    await materialise(member);
    const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headersFor(owner),
      body: JSON.stringify({}),
    });
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(member),
    });
    expect(joined.ok).toBe(true);
  }
  return server.id;
}

async function asAccount(page: Page, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
}

test.describe("watch party waitlist", () => {
  test("an owner asks for their server, and the sidebar says so", async ({ page }) => {
    const owner = `wl-owner-${Date.now()}`;
    const serverId = await seed(owner);
    await asAccount(page, owner);
    await page.goto(`/app/server/${serverId}?watchParty=1`);

    const teaser = page.locator("[data-live-party-teaser]");
    await expect(teaser).toHaveAttribute("data-live-party-teaser", "open");
    // The real create control is not offered: this server cannot run one.
    await expect(page.locator("[data-live-party-create]")).toHaveCount(0);
    await teaser.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-watch-party-stage-art]")).toBeVisible();
    await expect(dialog.locator("[data-watch-party-waitlist-view=request]")).toBeVisible();
    const submit = dialog.locator("[data-watch-party-waitlist-submit]");
    await expect(submit).toBeDisabled();
    await dialog.locator("[data-audience-bucket='50-150']").click();
    await dialog.getByPlaceholder("twitch.tv/yourchannel").fill("twitch.tv/filadeteste");
    await submit.click();

    await expect(dialog.locator("[data-watch-party-waitlist-done]")).toContainText(
      "You are on the list",
    );
    await dialog.getByRole("button", { name: "Close" }).last().click();
    await expect(teaser).toHaveAttribute("data-live-party-teaser", "on-list");

    // What the server kept is this account's own row, normalised.
    const state = await fetch(`${API}/api/watch-party/waitlist?serverId=${serverId}`, {
      headers: headersFor(owner),
    });
    expect(await state.json()).toMatchObject({
      canRequest: true,
      entry: {
        kind: "request",
        status: "waiting",
        audienceBucket: "50-150",
        streamChannel: "twitch.tv/filadeteste",
      },
    });
  });

  test("a member is told who can ask, and their interest is counted", async ({ page }) => {
    const stamp = Date.now();
    const owner = `wl-o-${stamp}`;
    const member = `wl-m-${stamp}`;
    const serverId = await seed(owner, member);
    await asAccount(page, member);
    await page.goto(`/app/server/${serverId}?watchParty=1`);

    await page.locator("[data-live-party-teaser]").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("[data-watch-party-waitlist-view=member]")).toBeVisible();
    await expect(dialog).toContainText("Ask whoever runs the server");
    await dialog.locator("[data-watch-party-waitlist-submit]").click();
    await expect(dialog.locator("[data-watch-party-waitlist-done]")).toContainText(
      "Your vote counts",
    );
  });

  test("the public page's intent opens the dialog after arrival", async ({ page }) => {
    const owner = `wl-intent-${Date.now()}`;
    const serverId = await seed(owner);
    await asAccount(page, owner);
    await page.goto(`/app/server/${serverId}?watchParty=1&intent=watch-party-waitlist`);
    await expect(
      page.getByRole("dialog").locator("[data-watch-party-waitlist-view=request]"),
    ).toBeVisible();
    // The intent is spent: it is gone from the address bar.
    await expect(page).not.toHaveURL(/intent=/);
  });

  test("the public page explains it and points at the app with the intent", async ({ page }) => {
    await page.goto("/watch-party");
    await expect(page.locator("[data-watch-party-stage-art]")).toBeVisible();
    const cta = page.getByRole("link", { name: /Join the waitlist/ }).first();
    await expect(cta).toHaveAttribute("href", "/app?intent=watch-party-waitlist");
  });
});
