import { expect, test } from "@playwright/test";

/**
 * A DM that lands while you are reading a server channel shows a corner card
 * with the sender, opens the conversation on click, and the conversation row
 * carries a count and a stamp. Two browser contexts: Bia writes, Ana reads.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function person(suffix: string, displayName: string): Promise<string> {
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ displayName }),
  });
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
  const me = (await (await fetch(`${API}/api/me`, { headers: headers(suffix) })).json()) as {
    user?: { id: string };
    id?: string;
  };
  return (me.user ?? me).id!;
}

test("a new DM toasts, badges the row, and opens on click", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const ana = `toast-ana-${stamp}`;
  const bia = `toast-bia-${stamp}`;
  await person(ana, "Ana");
  const biaId = await person(bia, "Bia");

  // A shared server, so the DM privacy default lets them talk.
  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ name: `Mesa ${stamp}` }),
    })
  ).json()) as { server: { id: string } };
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({}),
    })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headers(bia),
  });
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ userIds: [biaId] }),
    })
  ).json()) as { conversation: { channelId: string } };

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), ana);
  await anaPage.goto(`/app/server/${server.id}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });

  const biaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const biaPage = await biaContext.newPage();
  await biaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), bia);
  await biaPage.goto(`/app/dm/${conversation.channelId}?lang=en`);
  await expect(biaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
  await biaPage.getByPlaceholder(/Message/).fill("bora terça?");
  await biaPage.keyboard.press("Enter");

  // Ana, still on #general, sees the card.
  const toast = anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`);
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText("Bia");
  await expect(toast).toContainText("1 new message");
  if (process.env.SHOT_DIR) {
    await anaPage.screenshot({ path: `${process.env.SHOT_DIR}/dm-toast.png` });
  }

  // Opening it lands in the conversation and retires the card.
  await toast.getByRole("button", { name: /Bia/ }).click();
  await expect(anaPage).toHaveURL(new RegExp(`/app/dm/${conversation.channelId}`));
  await expect(anaPage.getByText("bora terça?")).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveCount(0);

  // The row carries a stamp (a time, since it was today).
  const row = anaPage.locator("[data-dm-recency]").first();
  await expect(row).toBeVisible();
  await expect(row).toHaveText(/\d{1,2}:\d{2}/);

  await anaContext.close();
  await biaContext.close();
});
