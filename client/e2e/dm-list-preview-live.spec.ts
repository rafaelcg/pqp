import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * A conversation's list row follows the messages sent while it is open.
 *
 * `channel-activity` moves a row only for somebody who is NOT looking at the
 * conversation, and it is never sent to the author. So the two people most
 * likely to be watching the row, the one who just sent and the one reading
 * along, used to keep the previous preview and time until a reload. The row
 * now updates from the `message-broadcast` both of them already receive.
 *
 * Same dev-bypass-over-HTTP harness as `dm-list-polish.spec.ts`.
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

async function seed(aSuffix: string, bSuffix: string): Promise<string> {
  await person(aSuffix, "Ana");
  const biaId = await person(bSuffix, "Bia");
  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(aSuffix),
      body: JSON.stringify({ name: `Preview ${Date.now()}` }),
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
  return conversation.channelId;
}

/**
 * Every person gets a browser context of their own (their own localStorage, so
 * their own dev identity). A context made by hand is not closed by the `page`
 * fixture, so they are tracked here and closed after the test, pass or fail:
 * left open, their pages and sockets outlive the test on a worker that goes on
 * to run others.
 */
const openedContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(openedContexts.splice(0).map((context) => context.close().catch(() => {})));
});

async function openConversation(
  browser: Browser,
  suffix: string,
  channelId: string,
): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  openedContexts.push(context);
  const page = await context.newPage();
  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), suffix);
  await page.goto(`/app/dm/${channelId}?lang=en`);
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 });
  return page;
}

async function send(page: Page, body: string): Promise<void> {
  await page.getByPlaceholder(/Message/).fill(body);
  await page.keyboard.press("Enter");
}

test("both rows follow the messages sent while the conversation is open", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const a = `preview-ana-${stamp}`;
  const b = `preview-bia-${stamp}`;
  const channelId = await seed(a, b);

  const ana = await openConversation(browser, a, channelId);
  const bia = await openConversation(browser, b, channelId);
  // Something already in the row, loaded from the list, so a stale row is
  // visibly stale rather than merely empty.
  await send(ana, "mensagem antiga");
  await expect(bia.getByRole("log").getByText("mensagem antiga")).toBeVisible({
    timeout: 15_000,
  });
  await ana.reload();
  await bia.reload();
  const anaRow = ana.locator("aside");
  const biaRow = bia.locator("aside");
  await expect(anaRow.getByText("you: mensagem antiga")).toBeVisible({ timeout: 15_000 });
  await expect(biaRow.getByText("mensagem antiga", { exact: true })).toBeVisible();

  // The author's own send: no `channel-activity` ever reaches the author.
  await send(ana, "**bora** hoje?");
  await expect(anaRow.getByText("you: bora hoje?")).toBeVisible({ timeout: 15_000 });
  // The reader with the conversation open: they get the broadcast instead.
  await expect(biaRow.getByText("bora hoje?", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await send(bia, "fechou!");
  await expect(biaRow.getByText("you: fechou!")).toBeVisible({ timeout: 15_000 });
  await expect(anaRow.getByText("fechou!", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // What the row said live is what the server's list says after a reload.
  await ana.reload();
  await expect(ana.locator("aside").getByText("fechou!", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});
