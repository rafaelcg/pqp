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

  // Ana, still on #general, sees the card. Previews default on, so the body
  // is the message itself, not the old "1 new message" count fallback.
  const toast = anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`);
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText("Bia");
  await expect(toast).toContainText("bora terça?");
  // Right-anchored on desktop, directly under where an incoming-call card
  // would sit (criterion 14/§3.1) — within 24px of the viewport's right edge.
  const box = await toast.boundingBox();
  const viewport = anaPage.viewportSize();
  if (box && viewport) {
    expect(viewport.width - (box.x + box.width)).toBeLessThan(24);
  }
  if (process.env.SHOT_DIR) {
    await anaPage.screenshot({ path: `${process.env.SHOT_DIR}/dm-toast.png` });
  }

  // Opening it lands in the conversation and retires the card (criterion 16).
  // The click lands on the big open button — the small dismiss X is a sibling
  // in the same card, not a descendant, so a click centred on the whole card
  // never risks it.
  await toast.click();
  await expect(anaPage).toHaveURL(new RegExp(`/app/dm/${conversation.channelId}`));
  // Scoped to the message log: the same words now also sit in the sidebar's
  // own preview line (this PR's own feature), so a bare page-wide text match
  // is ambiguous.
  await expect(
    anaPage.getByRole("log").getByText("bora terça?"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(toast).toHaveCount(0);

  // The row carries a stamp (a time, since it was today).
  const row = anaPage.locator("[data-dm-recency]").first();
  await expect(row).toBeVisible();
  await expect(row).toHaveText(/\d{1,2}:\d{2}/);

  await anaContext.close();
  await biaContext.close();
});

test("the X dismisses only that card, leaving a sibling untouched (criterion 17)", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const ana = `toast-x-ana-${stamp}`;
  const bia = `toast-x-bia-${stamp}`;
  const cid = `toast-x-cid-${stamp}`;
  await person(ana, "Ana");
  const biaId = await person(bia, "Bia");
  const cidId = await person(cid, "Cid");

  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ name: `Mesa X ${stamp}` }),
    })
  ).json()) as { server: { id: string } };
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({}),
    })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, { method: "POST", headers: headers(bia) });
  await fetch(`${API}/api/invites/${invite.code}/join`, { method: "POST", headers: headers(cid) });
  const { conversation: convBia } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ userIds: [biaId] }),
    })
  ).json()) as { conversation: { channelId: string } };
  const { conversation: convCid } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(ana),
      body: JSON.stringify({ userIds: [cidId] }),
    })
  ).json()) as { conversation: { channelId: string } };

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), ana);
  await anaPage.goto(`/app/server/${server.id}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
  // Ana's page gets its own frozen clock from here. What this test proves is
  // that the X's dismiss is scoped to one card (criterion 17), not that a
  // card survives a real 3-6s wall-clock window — that math (TOAST_MS,
  // VISIBILITY_RESUME_MS, pause/resume/freeze) is already pinned exactly,
  // with fake time, in dm-toast-queue.test.ts. Below, spinning up two more
  // browser contexts (sendFrom) is real work that can take longer in CI than
  // a card's own budget; with Date/setTimeout frozen on this page, none of
  // that setup time is ever charged against a card's countdown, so the final
  // assertion no longer races the clock. Time only moves when this test
  // explicitly asks it to (`clock.runFor`, below).
  await anaPage.clock.install();

  async function sendFrom(suffix: string, channelId: string, body: string) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), suffix);
    await page.goto(`/app/dm/${channelId}?lang=en`);
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
    await page.getByPlaceholder(/Message/).fill(body);
    await page.keyboard.press("Enter");
    await context.close();
  }

  await sendFrom(bia, convBia.channelId, "oi da bia");
  // Opening and closing Bia's own context can steal the OS-level foreground
  // window from Ana's page. A card only gets created while Ana's tab is
  // genuinely visible and focused (`shouldShowArrivalToast`) — bring it back
  // so the arrival is not silently dropped to the OS-banner path instead.
  await anaPage.bringToFront();
  const toastBia = anaPage.locator(`[data-dm-toast="${convBia.channelId}"]`);
  await expect(toastBia).toBeVisible({ timeout: 15_000 });

  await sendFrom(cid, convCid.channelId, "oi do cid");
  await anaPage.bringToFront();
  const toastCid = anaPage.locator(`[data-dm-toast="${convCid.channelId}"]`);
  await expect(toastCid).toBeVisible({ timeout: 15_000 });

  // The X on Cid's card dismisses only that one; Bia's is untouched. Both
  // cards' countdowns are frozen (see the `clock.install()` above), so this
  // is not a race against either card's own expiry.
  await toastCid.getByRole("button", { name: "Dismiss" }).click();
  // The exit animation's own unmount timer (`LEAVE_MS`, 200ms in
  // dm-toasts.tsx) is a real `setTimeout` too, now running on the frozen
  // clock — nudge it forward explicitly rather than polling wall-clock time
  // for a fake timer that will never fire on its own.
  await anaPage.clock.runFor(250);
  await expect(toastCid).toHaveCount(0, { timeout: 3_000 });
  await expect(toastBia).toBeVisible();

  await anaContext.close();
});
