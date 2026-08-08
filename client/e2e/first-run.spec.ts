import { expect, test, type Page } from "@playwright/test";

/**
 * What a brand-new account actually meets, driven rather than reasoned about.
 *
 * Two journeys, and until now neither had a spec at all — the suite's fixtures
 * stamp `onboardedAt` in setup precisely so that nothing ever sees the first-run
 * path, which is how it came to have the faults these tests pin:
 *
 *  1. Sign up with no invite. The wizard runs, the app opens on the hub, and the
 *     hub used to offer exactly one of the three things a new account needs —
 *     "add a friend". `Create server` and `Join invite` live in the empty state
 *     for a *selected* server, which an account with no servers cannot select, so
 *     the only route to a server was an unlabelled icon in the rail. The avatar
 *     was mentioned nowhere in the product.
 *
 *  2. Arrive on an invite link. That used to open a form asking the visitor to
 *     confirm the code they had just clicked, next to a Cancel button that threw
 *     away the only reason they were there — and for a new account, only *after*
 *     the wizard had offered them an empty "or use an invite" field while the app
 *     was already holding the code.
 *
 * Every test mints its own dev-bypass account (`dev-local-token:<suffix>`, the
 * mechanism `profile-popover-friends.spec.ts` uses) and answers the age gate but
 * NOT onboarding — that is the whole point. `fixtures.ts` cannot help here: its
 * `openApp` is hard-wired to the shared primary account, which has been stamped
 * as onboarded since the day the suite was written.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// A full boot plus a wizard plus, in the invite tests, a second account.
test.setTimeout(120_000);

/** The suffix alphabet the server accepts is `[a-z0-9_-]{1,32}` — no capitals. */
function suffixFor(name: string): string {
  return `fr-${name}-${Date.now().toString(36)}`.toLowerCase().slice(0, 32);
}

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

interface Account {
  suffix: string;
  id: string;
  tag: string;
}

/**
 * An account that exists and is over 18, and has answered nothing else.
 *
 * The `GET /api/me` is not just a read — it is what upserts the row, so it has to
 * come first. The age gate has to be next: it refuses every route but a handful,
 * so an un-gated account cannot even fetch its own server list, and the app would
 * open on the gate instead of on whatever the test is about.
 */
async function freshAccount(name: string): Promise<Account> {
  const suffix = suffixFor(name);
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { id: string; tag: string };
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  return { suffix, id: body.id, tag: body.tag };
}

/** A host with a server and a live invite code, for the arrival journeys. */
async function seedInvite(
  name: string,
  serverName: string,
): Promise<{ code: string; serverId: string; channelId: string }> {
  const host = await freshAccount(`${name}h`);
  const headers = headersFor(host.suffix);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: serverName }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers,
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string }[];
  };
  const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  return {
    code: invite.code,
    serverId: server.id,
    channelId: channels.find((one) => one.type === "text")!.id,
  };
}

/**
 * Point a browser context at one dev-bypass account and open a path.
 *
 * The readiness signal cannot be the "Dev auth bypass" strip the rest of the
 * suite waits on: that strip lives inside the app shell, and the wizard is a
 * full-screen replacement rendered *instead of* the shell — so on exactly the
 * accounts this spec exists for, it never appears. Either surface counts as
 * booted, and they are mutually exclusive by construction.
 */
async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(path);
  await expect(
    page
      .getByText("Dev auth bypass")
      .or(page.getByRole("heading", { name: "Now the paperwork" })),
  ).toBeVisible({ timeout: 20_000 });
}

/** Read one account's stored preferences straight from the API. */
async function storedPreferences(
  suffix: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/api/me`, { headers: headersFor(suffix) });
  const body = (await res.json()) as { preferences?: Record<string, unknown> };
  return body.preferences ?? {};
}

const card = "[data-first-run]";
const task = (id: string) => `[data-first-run-task="${id}"]`;

// ------------------------------------------------------ journey 1: no invite

test("a brand-new account is walked through the wizard and lands on three real affordances", async ({
  page,
}) => {
  const account = await freshAccount("solo");
  await openAs(page, "/app", account.suffix);

  // --- the wizard: read your handle -------------------------------------
  // Step one exists to show somebody the tag they were allocated, which is the
  // string anybody has to type to find them.
  await expect(page.getByText("Now the paperwork")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(account.tag, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Looks right" }).click();

  // --- the wizard: skip the rest ----------------------------------------
  await expect(page.getByText("Now the part people see")).toBeVisible();
  await page.getByRole("button", { name: "I'll do this later" }).click();

  // --- the hub, which is where the loss used to happen -------------------
  await expect(page.locator(card)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("heading", { name: "Three things and this place works" }),
  ).toBeVisible();

  // All three outstanding, and each one an actual button rather than a hint.
  for (const id of ["server", "friend", "avatar"]) {
    await expect(page.locator(task(id))).toHaveAttribute("data-done", "false");
  }
  await expect(page.getByRole("button", { name: "Make a server" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use an invite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a friend" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pick an avatar" })).toBeVisible();

  // The handle is printed again here on purpose: "add someone by their handle"
  // is useless advice until you know you have one, and the wizard showed it on a
  // screen they will never see again.
  await expect(page.locator(card).getByText(account.tag)).toBeVisible();
});

test("the checklist's buttons open the things they name", async ({ page }) => {
  const account = await freshAccount("acts");
  await openAs(page, "/app", account.suffix);
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "I'll do this later" }).click();
  await expect(page.locator(card)).toBeVisible({ timeout: 20_000 });

  // "Use an invite" — the join dialog, which the rail's unlabelled icon was the
  // only previous route to.
  await page.getByRole("button", { name: "Use an invite" }).click();
  await expect(page.getByPlaceholder("Invite code or link")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // "Add a friend" — this view's own handle search, opened in place.
  await page.getByRole("button", { name: "Add a friend" }).click();
  await expect(
    page.getByRole("combobox", { name: "Add a friend by handle" }),
  ).toBeVisible();

  // "Pick an avatar" — settings, which nothing in the product pointed at.
  // Asserted on the URL field rather than the upload button: upload only
  // exists when object storage is configured, which CI's environment is not,
  // and the row this button promises is the picker either way.
  await page.getByRole("button", { name: "Pick an avatar" }).click();
  await expect(page.getByPlaceholder("https://… image URL")).toBeVisible({
    timeout: 10_000,
  });
});

test("dismissing the checklist is permanent, across a reload and on the server", async ({
  page,
}) => {
  const account = await freshAccount("dism");
  await openAs(page, "/app", account.suffix);
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "I'll do this later" }).click();
  await expect(page.locator(card)).toBeVisible({ timeout: 20_000 });

  await page.locator("[data-first-run-dismiss]").click();
  await expect(page.locator(card)).toBeHidden();

  // Recorded as a preference, not in this tab's memory — a new browser must not
  // re-offer a checklist somebody already answered.
  await expect
    .poll(async () => (await storedPreferences(account.suffix)).firstRunDismissedAt, {
      timeout: 15_000,
    })
    .toBeTruthy();

  await page.reload();
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
  // The friends view is what the hub renders; wait for it rather than for a
  // fixed delay, so "hidden" means "hidden on a fully painted hub".
  await expect(page.getByRole("heading", { name: "Friends" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator(card)).toBeHidden();
});

test("making a server ticks the server row and leaves the other two", async ({
  page,
}) => {
  const account = await freshAccount("mksv");
  await openAs(page, "/app", account.suffix);
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "I'll do this later" }).click();
  await expect(page.locator(card)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Make a server" }).click();
  await page.getByPlaceholder("Server name").fill("Panelinha");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  // Creating opens the new server, so come back to the hub to read the card.
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Direct messages" }).click();
  await expect(page.locator(card)).toBeVisible({ timeout: 20_000 });

  await expect(page.locator(task("server"))).toHaveAttribute(
    "data-done",
    "true",
  );
  await expect(page.locator(task("friend"))).toHaveAttribute(
    "data-done",
    "false",
  );
  await expect(page.locator(task("avatar"))).toHaveAttribute(
    "data-done",
    "false",
  );
  // A done row keeps its place and loses its buttons, rather than vanishing and
  // re-laying the card out under the cursor that just clicked.
  await expect(
    page.locator(task("server")).getByRole("button", { name: "Make a server" }),
  ).toHaveCount(0);
});

// -------------------------------------------------- journey 2: invite arrival

test("an invite link carries a brand-new account into the server, not into a form", async ({
  page,
}) => {
  const invite = await seedInvite("newb", "Panelinha");
  const account = await freshAccount("newb");

  await openAs(page, `/app/invite/${invite.code}`, account.suffix);

  // The wizard still runs — the handle is worth reading whatever brought you
  // here — but it must not ask about the invite.
  await expect(page.getByText("Now the paperwork")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Looks right" }).click();
  await expect(page.getByText("Now the part people see")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // No third step. It used to offer an empty "or use an invite" field while the
  // app was holding the code, and there is nothing to ask.
  await expect(page.getByText("Nobody's here yet")).toBeHidden();
  // And no dialog asking them to confirm the link they clicked.
  await expect(page.getByPlaceholder("Invite code or link")).toBeHidden();

  // They are IN, in a channel, with the transcript open.
  await expect(page).toHaveURL(
    new RegExp(`/app/server/${invite.serverId}/channel/`),
    { timeout: 20_000 },
  );
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible();

  // …and told where they are, instead of meeting a markdown cheatsheet alone.
  const banner = page.locator("[data-arrival-banner]");
  await expect(banner).toBeVisible();
  await expect(banner.getByText("You're in Panelinha")).toBeVisible();
  await expect(banner.getByText("#general")).toBeVisible();

  // The membership is real, not just a navigation.
  const res = await fetch(`${API}/api/servers`, {
    headers: headersFor(account.suffix),
  });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  expect(servers.map((one) => one.id)).toContain(invite.serverId);
});

test("the arrival banner is dismissible and does not come back for that server", async ({
  page,
}) => {
  const invite = await seedInvite("dsmb", "Panelinha");
  const account = await freshAccount("dsmb");

  await openAs(page, `/app/invite/${invite.code}`, account.suffix);
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  const banner = page.locator("[data-arrival-banner]");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await banner.locator("[data-arrival-dismiss]").click();
  await expect(banner).toBeHidden();

  // Re-clicking the same link is a thing people do, and the server's redeem is
  // idempotent — so the join succeeds again and must not re-welcome them.
  await page.goto(`/app/invite/${invite.code}`);
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible({
    timeout: 20_000,
  });
  await expect(banner).toBeHidden();
});

test("an already-onboarded account clicking an invite is simply put in the channel", async ({
  page,
}) => {
  const invite = await seedInvite("vet", "Panelinha");
  const account = await freshAccount("vet");
  // Somebody who has been here a while: the wizard is behind them.
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headersFor(account.suffix),
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });

  await openAs(page, `/app/invite/${invite.code}`, account.suffix);

  await expect(page).toHaveURL(
    new RegExp(`/app/server/${invite.serverId}/channel/`),
    { timeout: 20_000 },
  );
  await expect(page.getByPlaceholder(/^Message /)).toBeVisible();
  await expect(page.locator("[data-arrival-banner]")).toBeVisible();
  // Never the confirm-what-you-clicked form.
  await expect(page.getByPlaceholder("Invite code or link")).toBeHidden();
});

test("a dead invite link falls back to the panel with the reason, not a silent nothing", async ({
  page,
}) => {
  const account = await freshAccount("dead");
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headersFor(account.suffix),
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });

  await openAs(page, "/app/invite/nosuchcode", account.suffix);

  // There has to be somewhere to go from here — ask for a fresh link, or paste a
  // different one — so the auto-join's refusal opens the panel rather than
  // leaving them on an empty hub wondering whether the click registered.
  const field = page.getByPlaceholder("Invite code or link");
  await expect(field).toBeVisible({ timeout: 20_000 });
  await expect(field).toHaveValue("nosuchcode");
  await expect(page.getByRole("alert")).toBeVisible();
});
