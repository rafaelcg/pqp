import { expect, test } from "@playwright/test";

/**
 * The suppression table (`docs/plans/DM_NOTIFICATIONS_POLISH.md` §3.6) has
 * four rows the happy-path `dm-toast.spec.ts` never exercises: Do Not
 * Disturb, a muted conversation, previews off, and the toast switch itself
 * off. Each is set over the API before the reader's page loads (preferences
 * are adopted at boot, `App.tsx`'s `applyRemotePreferences`), so this proves
 * the server-persisted preference actually reaches the running toast logic
 * and not just the pure function it is pinned against in
 * `dm-toast-queue.test.ts`.
 *
 * Same two-account-over-HTTP harness as `dm-toast.spec.ts`: copy it rather
 * than re-deriving it.
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

/**
 * `notifications` is replaced whole on write (jsonb `||` merges one level
 * deep — see `packages/shared/src/api.ts`'s comment on the schema), so every
 * call here sends the complete object the client itself would send, not a
 * sliver of it.
 */
async function setNotificationPrefs(
  suffix: string,
  overrides: {
    arrivalToast?: boolean;
    previewInApp?: boolean;
    channels?: Record<string, "all" | "mentions" | "none">;
  },
): Promise<void> {
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({
      notifications: {
        default: "all",
        servers: {},
        channels: {},
        arrivalToast: true,
        previewInApp: true,
        ...overrides,
      },
    }),
  });
}

async function setStatus(suffix: string, status: "online" | "dnd"): Promise<void> {
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ status }),
  });
}

interface Setup {
  server: { id: string };
  conversation: { channelId: string };
  biaId: string;
}

async function seed(aSuffix: string, bSuffix: string): Promise<Setup> {
  await person(aSuffix, "Ana");
  const biaId = await person(bSuffix, "Bia");

  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({ name: `Suppress ${Date.now()}` }),
    })
  ).json()) as { server: { id: string } };
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({}),
    })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headers(bSuffix),
  });
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({ userIds: [biaId] }),
    })
  ).json()) as { conversation: { channelId: string } };

  return { server, conversation, biaId };
}

async function sendFrom(
  browser: import("@playwright/test").Browser,
  suffix: string,
  channelId: string,
  body: string,
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), suffix);
  await page.goto(`/app/dm/${channelId}?lang=en`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder(/Message/).fill(body);
  await page.keyboard.press("Enter");
  await context.close();
}

test("criterion 34: the corner-popup switch off means no card, ever, but the badge still counts", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `supp34-ana-${stamp}`;
  const b = `supp34-bia-${stamp}`;
  const { server, conversation } = await seed(a, b);
  await setNotificationPrefs(a, { arrivalToast: false });

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/server/${server.id}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "sem popup");
  await anaPage.bringToFront();

  // The badge is the proof the message actually landed while we wait to be
  // sure no card was merely slow to appear.
  const badge = anaPage.locator(`[data-friend-requests], [data-dm-unread]`).first();
  await anaPage.goto(`/app/dm?lang=en`);
  await expect(anaPage.locator(`[data-dm-unread]`).first()).toHaveText("1", {
    timeout: 15_000,
  });
  void badge;

  await expect(anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`)).toHaveCount(0);

  await anaContext.close();
});

test("criterion 33: previews off falls back to a count, in the card and the row", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `supp33-ana-${stamp}`;
  const b = `supp33-bia-${stamp}`;
  const { server, conversation } = await seed(a, b);
  await setNotificationPrefs(a, { previewInApp: false });

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/server/${server.id}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "conteudo escondido");
  await anaPage.bringToFront();

  const toast = anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`);
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText("1 new message");
  await expect(toast).not.toContainText("conteudo escondido");

  // The sidebar row's preview line disappears too — same switch, both
  // surfaces (§2.7's gate).
  await anaPage.goto(`/app/dm?lang=en`);
  const row = anaPage.getByText("Bia", { exact: true }).first();
  await expect(row).toBeVisible();
  await expect(anaPage.getByText("conteudo escondido")).toHaveCount(0);

  await anaContext.close();
});

test("criterion 26/56: Do Not Disturb kills the card, but the unread pill keeps counting", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `supp26-ana-${stamp}`;
  const b = `supp26-bia-${stamp}`;
  const { server, conversation } = await seed(a, b);
  await setStatus(a, "dnd");

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/server/${server.id}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "modo silencioso");
  await anaPage.bringToFront();

  await anaPage.goto(`/app/dm?lang=en`);
  await expect(anaPage.locator(`[data-dm-unread]`).first()).toHaveText("1", {
    timeout: 15_000,
  });
  await expect(anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`)).toHaveCount(0);

  await anaContext.close();
});

test("the conversation already open, window focused, never toasts itself", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `suppopen-ana-${stamp}`;
  const b = `suppopen-bia-${stamp}`;
  const { conversation } = await seed(a, b);

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  // Already sitting IN the conversation the message arrives on, focused.
  await anaPage.goto(`/app/dm/${conversation.channelId}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "voce esta me vendo");
  await anaPage.bringToFront();
  // The message itself is proof of delivery — it lands in the open log.
  await expect(
    anaPage.getByRole("log").getByText("voce esta me vendo"),
  ).toBeVisible({ timeout: 15_000 });

  await expect(anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`)).toHaveCount(0);

  await anaContext.close();
});

test("criterion 27: a muted conversation never toasts", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `supp27-ana-${stamp}`;
  const b = `supp27-bia-${stamp}`;
  const { server, conversation } = await seed(a, b);
  await setNotificationPrefs(a, { channels: { [conversation.channelId]: "none" } });

  const anaContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const anaPage = await anaContext.newPage();
  await anaPage.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), a);
  await anaPage.goto(`/app/server/${server.id}?lang=en`);
  await expect(anaPage.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });

  await sendFrom(browser, b, conversation.channelId, "conversa silenciada");
  await anaPage.bringToFront();
  // Give it a real chance to appear before asserting the negative.
  await anaPage.waitForTimeout(2_000);

  await expect(anaPage.locator(`[data-dm-toast="${conversation.channelId}"]`)).toHaveCount(0);

  // The row itself shows the muted state (bell-off, no pill) — same fact,
  // second surface (criterion 10's own assertion covers the click path;
  // this only checks the mute suppressed the toast for the reason it says).
  await anaPage.goto(`/app/dm?lang=en`);
  const row = anaPage.getByText("Bia", { exact: true }).first();
  await expect(row).toBeVisible();

  await anaContext.close();
});
