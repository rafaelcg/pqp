import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * The profile card's avatar, pinned against the bug that made it useless: the
 * card drew a raw `<img src={subject.avatarUrl}>` while every other avatar in
 * the app went through `UserAvatar`.
 *
 * WHY THAT BROKE. An uploaded avatar's `avatarUrl` is ROOT-RELATIVE
 * (`/api/avatars/<id>?v=…` — see `avatarPath` in `@pqp/shared`, which is
 * relative because the API does not know its own public origin). `UserAvatar`
 * runs it through `resolveAvatarUrl`, which prefixes the API base; the card did
 * not, so the browser resolved it against the *SPA's* origin — Cloudflare Pages,
 * which has no `/api` — and drew a broken image inside the circle. The same
 * person's avatar in the member list a few pixels away was fine, because that
 * one is a `UserAvatar`. There was no `onError` either, so nothing fell back.
 *
 * The two origins are what this suite already reproduces faithfully: the client
 * runs on one port and the API on another, and `VITE_API_URL` points across.
 * The only thing simulated is the SPA origin having no `/api` at all, which is
 * true of every hosted deployment and false of the dev server (Vite proxies it).
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/**
 * A 64×64 PNG in four coloured quadrants, served for the avatar request.
 *
 * Quadrants rather than a flat colour on purpose: the failure this pins draws
 * a *fragment* of an image in the top-left of the circle, so a picture whose
 * corners differ makes "it filled the circle" visible in the screenshot and not
 * only in the numbers.
 */
const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXElEQVR4nO3PMREAIAwEsJeDREbkoYAJL0UDQ7fcxUBSWb1OWkVAQEBAQEBAQEBAQEBAQEBAQEBAQEBA4DuQXa3Gna0EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBL494NNdh3yl+SYAAAAASUVORK5CYII=",
  "base64",
);

/** The circle the card draws the picture inside: `h-20 w-20`. */
const CIRCLE = 80;

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

interface Account {
  id: string;
  displayName: string;
}

async function materialiseAccount(suffix: string): Promise<Account> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as {
    id: string;
    displayName: string;
    ageGate?: string;
  };
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
  return { id: body.id, displayName: body.displayName };
}

/**
 * Give this account the shape an uploaded avatar has: a root-relative path
 * under `/api/avatars/`. Nothing is really stored — the request is fulfilled by
 * the route below — but the *string the client receives* is the real one, which
 * is the whole subject of this spec.
 */
async function setUploadedAvatar(suffix: string, userId: string) {
  const response = await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headersFor(suffix),
    body: JSON.stringify({ avatarUrl: `/api/avatars/${userId}?v=deadbeef` }),
  });
  if (!response.ok) {
    throw new Error(`could not set the avatar: ${response.status}`);
  }
}

async function clearAvatar(suffix: string) {
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headersFor(suffix),
    body: JSON.stringify({ avatarUrl: null }),
  });
}

interface Shared {
  serverId: string;
  channelId: string;
  a: Account;
  b: Account;
}

async function seedSharedServer(
  aSuffix: string,
  bSuffix: string,
): Promise<Shared> {
  const a = await materialiseAccount(aSuffix);
  const b = await materialiseAccount(bSuffix);

  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({ name: `Avatar ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };

  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(aSuffix),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const channel = channels.find((one) => one.type === "text")!;

  const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({}),
  });
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(bSuffix),
  });
  if (!joined.ok) {
    throw new Error(`B could not join: ${joined.status}`);
  }

  return { serverId: server.id, channelId: channel.id, a, b };
}

/**
 * The two origins, as a hosted deployment has them: the API serves avatars, the
 * page's own origin has no `/api` at all and answers 404. A card that resolves
 * the path against the wrong one gets the 404 and draws a broken image.
 */
async function routeAvatars(page: Page, baseURL: string) {
  await page.route(`${API}/api/avatars/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: AVATAR_PNG,
      headers: { "Cache-Control": "no-store" },
    }),
  );
  await page.route(`${baseURL}/api/avatars/**`, (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "no api here" }),
  );
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(path);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * A picture of one element, kept on disk and on the report.
 *
 * Written through `outputPath` rather than handed to `attach` as bytes: an
 * inline attachment lives in the reporter's output, and the reporter this suite
 * runs locally has none — so the evidence for "the circle is full" would exist
 * only inside a passing run nobody can look at.
 */
async function shot(
  testInfo: TestInfo,
  target: Locator,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await target.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function secondClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  return { context, page };
}

/** Say something, so the other side has a name to click. */
async function say(page: Page, body: string) {
  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeVisible({ timeout: 20_000 });
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  await expect(page.getByText(body, { exact: true }).last()).toBeVisible();
}

test("an uploaded avatar fills the card's circle, exactly as it does in the message list", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const shared = await seedSharedServer("avatar-a", "avatar-b");
  await setUploadedAvatar("avatar-b", shared.b.id);
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    await routeAvatars(second.page, baseURL!);
    await openAs(second.page, channelPath, "avatar-b");
    const body = `avatar-${Date.now()}`;
    await say(second.page, body);

    await routeAvatars(page, baseURL!);
    await openAs(page, channelPath, "avatar-a");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });

    const trigger = page.locator(`[data-author-trigger="${shared.b.id}"]`).last();
    await expect(trigger).toBeVisible();
    await trigger.click();

    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();

    const avatar = card.locator("img").first();
    await expect(avatar).toBeVisible();

    // It actually loaded. `naturalWidth` is 0 for a broken image, which is what
    // the old card had: the src resolved against the page's own origin.
    await expect
      .poll(() => avatar.evaluate((node: HTMLImageElement) => node.naturalWidth), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    // And it fills the circle rather than sitting as a fragment inside it.
    const box = (await avatar.boundingBox())!;
    expect(Math.round(box.width)).toBe(CIRCLE);
    expect(Math.round(box.height)).toBe(CIRCLE);

    await shot(testInfo, card, "profile-card-avatar");
    // The whole window too: the point of the bug was that the card disagreed
    // with the member list about the same person's face, so the evidence has to
    // show both at once.
    await shot(testInfo, page.locator("body"), "profile-card-avatar-in-context");
  } finally {
    await second.context.close();
  }
});

test("no avatar leaves the monogram, and no image element at all", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const shared = await seedSharedServer("avatar-c", "avatar-d");
  await clearAvatar("avatar-d");
  const channelPath = `/app/server/${shared.serverId}/channel/${shared.channelId}`;
  const second = await secondClient(browser);

  try {
    await routeAvatars(second.page, baseURL!);
    await openAs(second.page, channelPath, "avatar-d");
    const body = `mono-${Date.now()}`;
    await say(second.page, body);

    await routeAvatars(page, baseURL!);
    await openAs(page, channelPath, "avatar-c");
    await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
      timeout: 20_000,
    });
    await page.locator(`[data-author-trigger="${shared.b.id}"]`).last().click();

    const card = page.locator("[data-profile-card]");
    await expect(card).toBeVisible();
    await expect(card.locator("img")).toHaveCount(0);
    await expect(
      card.getByText(shared.b.displayName.slice(0, 1).toUpperCase(), {
        exact: true,
      }),
    ).toBeVisible();

    await shot(testInfo, card, "profile-card-monogram");
  } finally {
    await second.context.close();
  }
});
