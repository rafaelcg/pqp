import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The Communities directory, driven end to end.
 *
 * WHAT THIS SUITE IS ACTUALLY FOR. Communities is the one feature in this repo
 * whose failure mode is legal rather than cosmetic (see docs/CONTENT_SAFETY.md
 * §"Communities"), so the assertions are weighted accordingly: the flag hiding
 * everything, the owner being told in words what listing means, and the report
 * control existing on every card matter more here than the grid looking right.
 *
 * The suite's server runs with `COMMUNITIES_ENABLED=true` — see the note in
 * playwright.config.ts, which also explains why the flag-off case is proved by
 * stubbing the config response rather than by booting a second server.
 *
 * Seeding goes through the API rather than the UI. Creating a server, adding a
 * second member so the row clears the directory's member floor, and opting it
 * in are three forms nobody is testing here, and driving them would make every
 * assertion below depend on all three.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/** Communities are owned by a second account, so the browser sees "Join". */
const OWNER = "comm-owner";
/** …and a third, purely to be the member that clears the floor. */
const FILLER = "comm-filler";

test.setTimeout(90_000);

function headers(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}${suffix ? `:${suffix}` : ""}`,
  };
}

/**
 * An account that exists and is over 18.
 *
 * The `GET /api/me` is what upserts the row, so it comes first; the age gate
 * refuses nearly every route until it is answered, so an un-gated seed account
 * cannot even create the server this suite needs.
 */
async function ensureAccount(suffix: string): Promise<void> {
  const me = await fetch(`${API}/api/me`, { headers: headers(suffix) });
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate === "passed") {
    return;
  }
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
}

/** A listed community with two members, owned by `OWNER`. */
async function seedCommunity(
  name: string,
  category: string,
  tagline: string,
): Promise<string> {
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
  const { invite: made } = (await invite.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${made.code}/join`, {
    method: "POST",
    headers: headers(FILLER),
  });

  const patched = await fetch(`${API}/api/servers/${server.id}/community`, {
    method: "PATCH",
    headers: headers(OWNER),
    body: JSON.stringify({ isCommunity: true, category, tagline }),
  });
  if (!patched.ok) {
    throw new Error(`could not list ${name}: ${patched.status}`);
  }
  return server.id;
}

/**
 * Leave the directory as empty as this suite found it.
 *
 * The suite shares one database across specs and one account across tests, so
 * a community left listed by an earlier test is a row in a later test's grid —
 * and the tests that assert "only this one is visible" would fail depending on
 * what ran before them. Unlisting is enough; deleting the servers would also
 * work and is slower for no gain.
 */
async function clearDirectory(): Promise<void> {
  for (const suffix of [OWNER, undefined]) {
    const res = await fetch(`${API}/api/servers`, { headers: headers(suffix) });
    if (!res.ok) {
      continue;
    }
    const body = (await res.json()) as { servers?: { id: string }[] };
    for (const server of body.servers ?? []) {
      await fetch(`${API}/api/servers/${server.id}/community`, {
        method: "PATCH",
        headers: headers(suffix),
        body: JSON.stringify({ isCommunity: false }),
      }).catch(() => {});
    }
  }
}

/**
 * The directory, from wherever the app happens to be.
 *
 * The compass lives at the foot of the server rail, which is on screen in every
 * selection — so unlike the old sidebar row, this needs no trip through home
 * first. That is the whole point of the move, and driving it this way is what
 * pins it: if the compass ever became conditional on the conversation view
 * again, every test below would fail.
 */
async function openDirectory(page: Page): Promise<void> {
  await openApp(page);
  await reopenDirectory(page);
}

/** The same click, for tests that come back after joining something. */
async function reopenDirectory(page: Page): Promise<void> {
  await page.locator("[data-communities-rail]").click();
  await expect(page.locator("[data-communities-view]")).toBeVisible();
}

function card(page: Page, name: string) {
  return page.locator("[data-community]").filter({ hasText: name });
}

test.describe("Communities", () => {
  test.beforeEach(async () => {
    await ensureAccount(OWNER);
    await ensureAccount(FILLER);
    await clearDirectory();
  });

  test("the rail's compass opens the directory", async ({ page }) => {
    await seedCommunity(
      "Eu odeio acordar cedo",
      "humor",
      "quem acorda cedo é herói",
    );
    await openDirectory(page);

    // The headline, not the screen's name: the directory took the viewport
    // and now leads with what the reader gets to do.
    await expect(
      page.getByRole("heading", { name: "Find your people" }),
    ).toBeVisible();
    // …and it really is the whole viewport, not a pane beside the sidebars.
    const view = page.locator("[data-communities-view]");
    const box = await view.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width).toBe(viewport.width);
    expect(box!.height).toBe(viewport.height);
    await expect(card(page, "Eu odeio acordar cedo")).toBeVisible();
    await expect(page.getByText("quem acorda cedo é herói")).toBeVisible();
    // The member count is the directory's only ordering key and the only thing
    // on a card that is not owner-written, so it is worth pinning that it is a
    // real number rather than a placeholder.
    await expect(card(page, "Eu odeio acordar cedo")).toContainText("2 members");
    // Every card carries its own report control. A public directory that can
    // only be complained about through a support address is what the research
    // doc's §08 says not to ship.
    await expect(
      card(page, "Eu odeio acordar cedo").getByRole("button", {
        name: /Report this community/,
      }),
    ).toBeAttached();
  });

  test("category chips narrow the grid", async ({ page }) => {
    await seedCommunity("Só mais 5 minutinhos", "humor", "cinco minutos");
    await seedCommunity("Pagode do fim de semana", "musica", "só pagode");
    await openDirectory(page);

    await expect(card(page, "Só mais 5 minutinhos")).toBeVisible();
    await expect(card(page, "Pagode do fim de semana")).toBeVisible();

    await page.locator('[data-category="musica"]').click();
    await expect(card(page, "Pagode do fim de semana")).toBeVisible();
    await expect(card(page, "Só mais 5 minutinhos")).toHaveCount(0);

    await page.locator('[data-category="all"]').click();
    await expect(card(page, "Só mais 5 minutinhos")).toBeVisible();
  });

  test("search finds a community by name", async ({ page }) => {
    await seedCommunity("Imagina se pega no olho", "humor", "imagina só");
    await seedCommunity("Tech BR", "tech", "código e café");
    await openDirectory(page);

    await page
      .getByRole("searchbox", { name: "Search communities" })
      .fill("olho");
    await expect(card(page, "Imagina se pega no olho")).toBeVisible();
    await expect(card(page, "Tech BR")).toHaveCount(0);
  });

  test("joining lands you inside the server", async ({ page }) => {
    const serverId = await seedCommunity(
      "Anão vestido de palhaço",
      "humor",
      "entra aí",
    );
    await openDirectory(page);

    await card(page, "Anão vestido de palhaço")
      .getByRole("button", { name: "Join", exact: true })
      .click();

    // The whole round trip: the app switches to that server, its channels load,
    // and the composer — which only exists inside a text channel — comes back.
    await expect(page).toHaveURL(new RegExp(`/app/server/${serverId}`), {
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });

    // Back to the directory: the card now offers "Open", not "Join", which is
    // the visible half of the server's per-viewer `joined` flag.
    await reopenDirectory(page);
    await expect(
      card(page, "Anão vestido de palhaço").getByRole("button", {
        name: "Open",
      }),
    ).toBeVisible();
  });

  test("joining twice is the same join", async ({ page }) => {
    // Idempotency at the surface people actually hit it from: a slow card, a
    // double tap, a retry. The server's `ON CONFLICT DO NOTHING` is pinned in
    // the server suite; this is that guarantee reaching the user.
    await seedCommunity("Duas vezes", "geral", "clica duas vezes");
    await openDirectory(page);

    const join = card(page, "Duas vezes").getByRole("button", {
      name: "Join",
      exact: true,
    });
    await join.dblclick();

    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
    await reopenDirectory(page);
    await expect(card(page, "Duas vezes")).toHaveCount(1);
    await expect(
      card(page, "Duas vezes").getByRole("button", { name: "Open" }),
    ).toBeVisible();
  });

  test("an owner's settings say what listing publicly means", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Server settings" }).click();

    const section = page.locator("[data-community-settings]");
    await expect(section).toBeVisible();
    // THE COPY IS THE FEATURE. An owner has to be told, before they tick the
    // box, that the room becomes publicly findable and that anyone can walk in
    // without an invite and without their approval.
    await expect(section).toContainText(/publicly|público/i);
    await expect(section).toContainText(/no invite|sem convite/i);
    // …and that reports about it go past them, to whoever runs the instance.
    await expect(section).toContainText(
      /people who run pqp|quem cuida do pqp/i,
    );
    await expect(
      section.getByRole("checkbox", { name: /List this community publicly/i }),
    ).toBeVisible();
  });

  test("the create call to action hands you the make-a-community form", async ({
    page,
  }) => {
    // The other half of the feature, and the reason it is above the grid rather
    // than under it: a directory whose only answer to "none of these are mine"
    // is a scroll teaches people that making one is an advanced move.
    await seedCommunity("Nada a ver comigo", "geral", "não é pra você");
    await openDirectory(page);

    await page
      .getByRole("button", { name: "Create a community", exact: true })
      .click();

    // The directory gets out of the way, and the form it handed you is the
    // existing create flow — renamed, not rebuilt.
    await expect(page.locator("[data-communities-view]")).toHaveCount(0);
    await expect(page.getByPlaceholder("Community name")).toBeVisible();
  });

  test("escape and the close button both put the app back", async ({ page }) => {
    await seedCommunity("Sai fora", "geral", "tchau");
    await openDirectory(page);

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-communities-view]")).toHaveCount(0);

    await reopenDirectory(page);
    await page.getByRole("button", { name: "Close the directory" }).click();
    await expect(page.locator("[data-communities-view]")).toHaveCount(0);
    // And what was underneath is still there — the directory is a mode, not a
    // navigation, so closing it must not have moved anybody anywhere.
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("a joined community says so on the card", async ({ page }) => {
    await seedCommunity("Já entrei", "geral", "tô dentro");
    await openDirectory(page);

    await card(page, "Já entrei")
      .getByRole("button", { name: "Join", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });

    await reopenDirectory(page);
    // The button already says "Open", but that is one word of difference
    // between two cards side by side. The pill is what survives a glance.
    await expect(card(page, "Já entrei")).toContainText("You're in");
  });

  test("with the flag off, nothing about Communities renders", async ({
    page,
  }) => {
    // The client's half of the gate. The server's half — every route answering
    // 404 with the variable unset — is pinned in the server suite, which can
    // control the environment the routes actually read.
    await page.route("**/api/communities/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    await seedCommunity("Invisível", "geral", "não deve aparecer");
    await openApp(page);
    await page.goto("/app/dm");
    await expect(page.getByRole("button", { name: "Friends" })).toBeVisible();

    // No compass on the rail…
    await expect(page.locator("[data-communities-rail]")).toHaveCount(0);
    // …no view…
    await expect(page.locator("[data-communities-view]")).toHaveCount(0);
    // …and no opt-in section in Server settings.
    await page.goto("/app");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Server settings" }).click();
    await expect(page.getByText(/Server name/i).first()).toBeVisible();
    await expect(page.locator("[data-community-settings]")).toHaveCount(0);
  });
});
