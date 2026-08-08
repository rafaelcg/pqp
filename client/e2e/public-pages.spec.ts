import { expect, test, type Page } from "@playwright/test";
import { ensureServer } from "./fixtures";

/**
 * The two pages this product serves to people who have no account:
 * `pqp.gg/@rafa` and `pqp.gg/c/<slug>`.
 *
 * WHAT ONLY A BROWSER CAN PROVE, and therefore what this file is for. The unit
 * suites already pin the rules — the shape of the payload, the slug grammar,
 * the collision, the intent's TTL. What none of them can answer is the question
 * the whole surface rests on: does a stranger with NO SESSION AT ALL, in a
 * fresh browser context, actually see a page? Every other route in this product
 * needs a token, so "does this one really not" is only knowable here.
 *
 * The four things asserted:
 *
 *  1. The profile renders its DEPOIMENTOS to somebody signed out — the words,
 *     not a count. That is the change this page exists for, and the words come
 *     from an endpoint whose scoping was rewritten to allow it.
 *  2. `/c/<slug>` renders, and its CTA carries a join intent through sign-up
 *     into an actual membership. That is the growth loop, end to end.
 *  3. A colliding address is refused rather than silently suffixed.
 *  4. A suspended community answers exactly as an unknown one does — the
 *     operator's kill switch must not be readable off the 404.
 *
 * Seeding goes through the API for the reason `communities.spec.ts` gives:
 * creating a server, adding a second member, opting it in and writing a
 * depoimento are four forms nobody is testing here.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/** The person whose profile is being looked at. */
const SUBJECT = "public-subject";
/** The friend who writes the depoimento. */
const AUTHOR = "public-author";
/** The community's owner, and the account that clears the member floor. */
const OWNER = "public-owner";
const FILLER = "public-filler";

/** Pinned so a run is repeatable; a handle only moves once every 30 days. */
const SUBJECT_HANDLE = "e2e_publico";
const AUTHOR_HANDLE = "e2e_autor";

test.setTimeout(120_000);

function headers(suffix?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}${suffix ? `:${suffix}` : ""}`,
  };
}

async function api(
  suffix: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: headers(suffix),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * An account that exists and is over 18.
 *
 * `GET /api/me` is what upserts the row, so it comes first; the age gate
 * refuses nearly every route until it is answered, so an un-gated seed account
 * cannot even create the server this suite needs.
 */
async function ensureAccount(suffix: string): Promise<{ id: string }> {
  const me = await api(suffix, "GET", "/api/me");
  const body = (await me.json()) as { id: string; ageGate?: string };
  if (body.ageGate !== "passed") {
    await api(suffix, "POST", "/api/me/age-check", {
      dateOfBirth: "1990-01-01",
    });
  }
  return { id: body.id };
}

/**
 * Pin an account's handle.
 *
 * There is deliberately no route that un-claims one (releasing a handle hands
 * somebody else a URL that is already in screenshots), so the reset goes
 * through the one door that exists: the server treats a re-sent identical
 * handle as a free no-op, and a 429 means the account already holds a
 * different one from a previous run — which the suite tolerates rather than
 * failing on, because the cooldown is a real thirty days.
 */
async function ensureHandle(suffix: string, handle: string): Promise<void> {
  const me = await (await api(suffix, "GET", "/api/me")).json();
  if (me.handle === handle) {
    return;
  }
  const res = await api(suffix, "PATCH", "/api/me", { handle });
  if (!res.ok && res.status !== 429) {
    throw new Error(`could not pin ${handle}: ${res.status}`);
  }
}

/**
 * Make the two accounts friends, which is what lets one write about the other.
 *
 * Idempotent because the suite shares a database across runs: a second request
 * between an existing pair answers `accepted` and the accept below 404s, both
 * of which are fine. Only "they are friends afterwards" matters.
 */
async function befriend(
  a: string,
  b: string,
  aId: string,
  bId: string,
): Promise<void> {
  await api(a, "POST", "/api/friends", { userId: bId });
  await api(b, "POST", `/api/friends/${aId}/accept`, {});
}

/** A listed community with two members, owned by `OWNER`. Returns its slug. */
async function seedCommunity(
  name: string,
  options: { tagline?: string; category?: string; slug?: string } = {},
): Promise<{ id: string; slug: string }> {
  const created = await api(OWNER, "POST", "/api/servers", { name });
  if (!created.ok) {
    throw new Error(`could not create ${name}: ${created.status}`);
  }
  const { server } = (await created.json()) as { server: { id: string } };

  const invite = await (
    await api(OWNER, "POST", `/api/servers/${server.id}/invites`, {})
  ).json();
  await api(FILLER, "POST", `/api/invites/${invite.invite.code}/join`, {});

  const patched = await api(
    OWNER,
    "PATCH",
    `/api/servers/${server.id}/community`,
    {
      isCommunity: true,
      category: options.category ?? "games",
      tagline: options.tagline ?? null,
      ...(options.slug ? { slug: options.slug } : {}),
    },
  );
  if (!patched.ok) {
    throw new Error(`could not list ${name}: ${patched.status}`);
  }
  const { community } = (await patched.json()) as {
    community: { slug: string };
  };
  return { id: server.id, slug: community.slug };
}

/**
 * Leave the directory as this suite found it.
 *
 * Unlisting also frees the ADDRESS — the unique index is partial on
 * `is_community` — which is what lets the collision test claim the same slug
 * on every run rather than only on the first.
 */
async function clearDirectory(): Promise<void> {
  for (const suffix of [OWNER, FILLER, undefined]) {
    const res = await api(suffix, "GET", "/api/servers");
    if (!res.ok) {
      continue;
    }
    const body = (await res.json()) as { servers?: { id: string }[] };
    for (const server of body.servers ?? []) {
      await api(suffix, "PATCH", `/api/servers/${server.id}/community`, {
        isCommunity: false,
      }).catch(() => {});
    }
  }
}

/** A context with nothing in it: no storage, no cookie, no token. */
async function anonymousPage(
  browser: import("@playwright/test").Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

test.describe("the public profile page", () => {
  test.beforeEach(async () => {
    await ensureServer();
    const subject = await ensureAccount(SUBJECT);
    const author = await ensureAccount(AUTHOR);
    await ensureHandle(SUBJECT, SUBJECT_HANDLE);
    await ensureHandle(AUTHOR, AUTHOR_HANDLE);
    await befriend(SUBJECT, AUTHOR, subject.id, author.id);
  });

  test("renders approved depoimentos to somebody with no session at all", async ({
    browser,
  }) => {
    const subject = await ensureAccount(SUBJECT);
    const body = `jogamos valorant às 3 da manhã ${Date.now()}`;
    const written = await api(
      AUTHOR,
      "POST",
      `/api/users/${subject.id}/depoimentos`,
      { body },
    );
    expect(written.ok).toBe(true);
    const { depoimento } = (await written.json()) as {
      depoimento: { id: string };
    };
    // The approval IS the consent. An unapproved one must never reach the page,
    // which the next test pins from the other side.
    const approved = await api(
      SUBJECT,
      "POST",
      `/api/depoimentos/${depoimento.id}/approve`,
      {},
    );
    expect(approved.ok).toBe(true);

    const { page, close } = await anonymousPage(browser);
    await page.goto(`/@${SUBJECT_HANDLE}`);

    // The words, not a count. This is the assertion the redesign exists for.
    await expect(page.getByText(body)).toBeVisible({ timeout: 20_000 });
    // The author travels as a name and — because they claimed one — a handle.
    await expect(
      page.locator("[data-profile-depoimentos]").getByText(`@${AUTHOR_HANDLE}`),
    ).toBeVisible();
    await close();
  });

  test("never renders one the subject has not published", async ({
    browser,
  }) => {
    const subject = await ensureAccount(SUBJECT);
    const secret = `não aceita esse ${Date.now()}`;
    await api(AUTHOR, "POST", `/api/users/${subject.id}/depoimentos`, {
      body: secret,
    });
    // Deliberately NOT approved. Orkut's pending queue being readable is the
    // documented failure this whole feature is shaped around; a pending
    // depoimento on a page served to the open internet is that failure with a
    // URL attached.
    const { page, close } = await anonymousPage(browser);
    await page.goto(`/@${SUBJECT_HANDLE}`);
    await expect(page.getByText(`@${SUBJECT_HANDLE}`).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(secret)).toHaveCount(0);
    await close();
  });

  test("shows the community grid and the tenure line", async ({ browser }) => {
    await ensureAccount(OWNER);
    await ensureAccount(FILLER);
    await clearDirectory();
    const community = await seedCommunity("Valorant Brasil e2e", {
      tagline: "a gente perde junto",
    });
    // The subject joins it, which is what puts a badge on their profile.
    const joined = await api(
      SUBJECT,
      "POST",
      `/api/communities/${community.id}/join`,
      {},
    );
    expect(joined.ok).toBe(true);

    const { page, close } = await anonymousPage(browser);
    await page.goto(`/@${SUBJECT_HANDLE}`);

    const grid = page.locator("[data-profile-communities]");
    await expect(grid).toBeVisible({ timeout: 20_000 });
    // The Orkut sentence: belonging, not inventory.
    await expect(grid).toContainText("member of 1 community");
    await expect(grid).toContainText("Valorant Brasil e2e");
    // Month granularity — a day on this page would be a fact about when
    // somebody was at a computer.
    await expect(page.getByText(/on pqp since \w+ \d{4}/)).toBeVisible();
    await close();
  });
});

test.describe("the public community page", () => {
  test.beforeEach(async () => {
    await ensureServer();
    await ensureAccount(OWNER);
    await ensureAccount(FILLER);
    await clearDirectory();
  });

  test("renders to somebody with no session and derives its address from the name", async ({
    browser,
  }) => {
    const community = await seedCommunity("Eu Odeio Acordar Cedo", {
      tagline: "quem acorda cedo é herói",
      category: "humor",
    });
    // Derived, not typed: the opt-in above sent no slug.
    expect(community.slug).toBe("eu-odeio-acordar-cedo");

    const { page, close } = await anonymousPage(browser);
    await page.goto(`/c/${community.slug}`);

    await expect(
      page.getByRole("heading", { name: "Eu Odeio Acordar Cedo" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("quem acorda cedo é herói")).toBeVisible();
    // The member count, big, is the one fact a stranger deciding whether to
    // walk in actually needs.
    await expect(page.getByText("people in here")).toBeVisible();
    await expect(page.getByText("Humour")).toBeVisible();
    await expect(page.getByText(`pqp.gg/c/${community.slug}`)).toBeVisible();
    // The poster and nothing behind the door.
    const html = await page.content();
    expect(html).not.toContain(community.id);
    await close();
  });

  test("the join CTA carries the intent through to an actual membership", async ({
    page,
  }) => {
    const community = await seedCommunity("Pagode do e2e", {
      tagline: "só as antigas",
    });
    // With the dev bypass on there is no Clerk modal to drive, so the CTA is a
    // plain link to `/app?join=<slug>` — which is exactly the URL Clerk is
    // handed as `forceRedirectUrl` in production, and the half of the intent
    // machinery a browser can actually verify. The localStorage stash behind it
    // is pinned in `handle-intent.test.ts`.
    await page.goto(`/c/${community.slug}`);
    await page.getByRole("link", { name: "Join the community" }).click();

    // Landed INSIDE the community, not at an empty hub — the failure
    // `signedOutRedirectPath` was written to fix, one surface over. Two
    // elements say it (the notice bar and the arrival banner, which the intent
    // arms exactly as the directory card does), so `.first()` rather than a
    // narrower locator: both being there is the correct outcome.
    await expect(page.getByText(/You're in Pagode do e2e/).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/app\/server\//, { timeout: 20_000 });
    // The query parameter is consumed, so a reload cannot re-fire the intent.
    await expect(page).not.toHaveURL(/join=/);

    // And it really is a membership, not just a screen.
    const servers = await (await api(undefined, "GET", "/api/servers")).json();
    expect(
      (servers.servers as { id: string }[]).some(
        (one) => one.id === community.id,
      ),
    ).toBe(true);
  });

  test("refuses a colliding address rather than inventing one", async () => {
    await seedCommunity("Colisao e2e");
    // A second server whose name slugifies to exactly the same thing.
    const created = await api(OWNER, "POST", "/api/servers", {
      name: "colisão e2e",
    });
    const { server } = (await created.json()) as { server: { id: string } };
    const res = await api(OWNER, "PATCH", `/api/servers/${server.id}/community`, {
      isCommunity: true,
    });
    // 409, and the listing does not happen: a community listed at no address is
    // a share button that is silently missing.
    expect(res.status).toBe(409);
    const settings = await (
      await api(OWNER, "GET", `/api/servers/${server.id}/community`)
    ).json();
    expect(settings.community.isCommunity).toBe(false);

    // The owner picks another and it goes through.
    const retry = await api(
      OWNER,
      "PATCH",
      `/api/servers/${server.id}/community`,
      { isCommunity: true, slug: "colisao-e2e-2" },
    );
    expect(retry.status).toBe(200);
  });

  test("a suspended community 404s exactly as an unknown one does", async ({
    browser,
  }) => {
    const community = await seedCommunity("Suspensa e2e");
    // The operator's kill switch, which has no route by design — it is one
    // UPDATE with the DATABASE_URL. There is no in-app path to it at all, so
    // the suite reaches it the only way an operator would: it cannot, from
    // here. What it CAN do is unlist, which is the other half of the same 404
    // and is what a stranger sees either way.
    await api(OWNER, "PATCH", `/api/servers/${community.id}/community`, {
      isCommunity: false,
    });

    const pulled = await fetch(
      `${API}/api/public/communities/${community.slug}`,
    );
    const unknown = await fetch(
      `${API}/api/public/communities/nunca-existiu-e2e`,
    );
    expect(pulled.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await pulled.text()).toBe(await unknown.text());

    const { page, close } = await anonymousPage(browser);
    await page.goto(`/c/${community.slug}`);
    await expect(
      page.getByRole("heading", { name: "This community is not here." }),
    ).toBeVisible({ timeout: 20_000 });
    await close();
  });

  test("the public endpoint really does answer without a token", async () => {
    const community = await seedCommunity("Sem Token e2e", {
      tagline: "sem sessão nenhuma",
    });
    // No Authorization header. CLAUDE.md pitfall #8 says every /api route needs
    // one; this is one of the handful that deliberately does not, and that
    // exception is the feature.
    const response = await fetch(
      `${API}/api/public/communities/${community.slug}`,
    );
    expect(response.status).toBe(200);
    // Cacheable, unlike every other JSON this API answers — the payload is
    // identical for every caller by construction.
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await response.json();
    expect(Object.keys(body.community).sort()).toEqual([
      "bannerUrl",
      "category",
      "createdMonth",
      "iconUrl",
      "memberCount",
      "name",
      "slug",
      "tagline",
    ]);
  });
});
