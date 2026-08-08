import { expect, test, type Page } from "@playwright/test";
import { ensureServer, openApp } from "./fixtures";

/**
 * Public handles, end to end, through the browser.
 *
 * The unit suites already prove the rules (validation, the cooldown, the
 * uniqueness race) and the meta rewrite. What only a browser can prove is the
 * part this feature actually lives or dies on:
 *
 *  - a claimed handle renders `pqp.gg/@name` to somebody WITH NO SESSION. Every
 *    other page in this product needs a token, so "does this one really not"
 *    cannot be asserted anywhere but here — the whole growth loop is a stranger
 *    opening a link;
 *  - the claim landing's availability check answers, and the answer changes when
 *    the handle is taken;
 *  - `/@nobody` is a page rather than a wall;
 *  - the intent survives the navigation to the app.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/**
 * The suite shares one dev-bypass account against a persistent database, and a
 * handle can only be changed once every 30 days — so a spec that claimed a
 * fresh name each run would work once and 429 forever after. The handle is
 * therefore reset in the database's own terms before each spec: clear it, clear
 * the cooldown stamp.
 *
 * Done over HTTP rather than SQL because these specs have no database
 * connection, and the API has no route that un-claims a handle (deliberately —
 * releasing one hands somebody else a URL that is already in screenshots). So
 * the reset goes through the one door that exists: rename with the cooldown
 * already spent is impossible, but a *first* claim is free, and the server
 * treats a re-sent identical handle as a free no-op. Fixing the handle to one
 * stable value per run is what makes the suite repeatable.
 */
const HANDLE = "e2e_handle";

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEV_TOKEN}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The shared account's handle, pinned to one value so runs are repeatable. */
async function ensureHandle(): Promise<void> {
  // `PATCH /api/me` is behind the 18+ gate, and on the fresh database CI creates
  // the shared account has not answered it — so without this every spec here
  // dies on a 403 that has nothing to do with handles. Same one-time setup
  // `openApp` does; called directly because half these specs never open the app.
  await ensureServer();
  const me = await (await api("GET", "/api/me")).json();
  if (me.handle === HANDLE) {
    return;
  }
  const response = await api("PATCH", "/api/me", { handle: HANDLE });
  if (!response.ok && response.status !== 429) {
    throw new Error(`could not pin the handle: ${response.status}`);
  }
}

async function openSettingsProfile(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
}

test.describe("public handles", () => {
  test("Settings shows the public link and a way to copy it", async ({
    page,
  }) => {
    await ensureHandle();
    await openApp(page);
    await openSettingsProfile(page);

    const panel = page.getByRole("tabpanel");
    // The field and the link are two different objects on purpose — the input
    // is a draft, the code block is what you own. Both have to be there.
    await expect(panel.getByText("pqp.gg/@", { exact: true })).toBeVisible();
    await expect(panel.getByText(`pqp.gg/@${HANDLE}`)).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Copy link" }),
    ).toBeVisible();
  });

  test("claiming from Settings is refused a second time inside the window", async ({
    page,
  }) => {
    await ensureHandle();
    await openApp(page);
    await openSettingsProfile(page);

    // The cooldown disables the field rather than letting somebody type a name
    // the server is going to refuse. That is the whole affordance.
    const field = page.getByRole("tabpanel").getByPlaceholder("yourname");
    await expect(field).toBeDisabled();
  });

  test("a claimed handle renders for somebody with no session at all", async ({
    browser,
  }) => {
    await ensureHandle();
    // A FRESH CONTEXT with nothing in it: no storage, no cookie, no token. This
    // is the assertion the entire feature rests on.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/@${HANDLE}`);

    await expect(page.getByText(`@${HANDLE}`).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("heading", { level: 1 }),
    ).toBeVisible();
    // The one thing to do on the page.
    await expect(
      page.getByRole("link", { name: /Add me on pqp|Open in pqp/ }),
    ).toBeVisible();
    // …and the loop's other half.
    await expect(page.getByRole("link", { name: "Claim your @" })).toBeVisible();

    // Nothing that identifies the account behind the page. The server suite
    // pins the JSON; this pins what actually reaches the screen.
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("#");
    expect(text).not.toContain("dev-local");

    await context.close();
  });

  test("an unclaimed handle is an offer, not a dead end", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/@ninguem_aqui_mesmo");

    await expect(
      page.getByRole("heading", { name: /is free/ }),
    ).toBeVisible({ timeout: 15_000 });
    const claim = page.getByRole("link", { name: /Claim @ninguem/ });
    await expect(claim).toBeVisible();

    // …and it carries the name across to the landing, already typed in.
    await claim.click();
    await expect(page).toHaveURL(/\/garanta\?handle=ninguem_aqui_mesmo/);
    await expect(page.getByLabel("The @ you want")).toHaveValue(
      "ninguem_aqui_mesmo",
    );

    await context.close();
  });

  test("a reserved word is not offered, because it would be refused", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/@suporte");

    await expect(page.getByRole("heading", { name: /is free/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("link", { name: /Claim @suporte/ })).toHaveCount(
      0,
    );

    await context.close();
  });

  test("the landing checks availability live, signed out", async ({
    browser,
  }) => {
    await ensureHandle();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/garanta");

    const field = page.getByLabel("The @ you want");
    await expect(field).toBeFocused();

    // Taken: the account pinned above holds it.
    await field.fill(HANDLE);
    await expect(page.getByRole("status")).toContainText("is taken", {
      timeout: 15_000,
    });

    // Free: nobody holds this one.
    await field.fill("livre_de_verdade");
    await expect(page.getByRole("status")).toContainText("is free", {
      timeout: 15_000,
    });

    // Refused before a request is made — the client knows the rules too.
    await field.fill("ab");
    await expect(page.getByRole("status")).toContainText("At least 3");
    await field.fill("admin");
    await expect(page.getByRole("status")).toContainText("reserved");

    await context.close();
  });

  test("the chosen handle survives the trip into the app", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/garanta");

    await page.getByLabel("The @ you want").fill("intencao_teste");
    await expect(page.getByRole("status")).toContainText("is free", {
      timeout: 15_000,
    });

    // The dev-bypass build renders no Clerk provider, so the button is a plain
    // link — which is exactly where the intent has to be visible. Both halves
    // are asserted: the URL that carries it, and the stash that backs the URL
    // up when a hosted auth round trip eats the query string.
    const cta = page.getByRole("link", { name: /Claim @intencao_teste/ });
    await expect(cta).toHaveAttribute("href", "/app?claim=intencao_teste");
    await cta.click();

    // The app consumes it and wipes the query string so a reload cannot repeat
    // the claim.
    await expect(page).toHaveURL(/\/app(\/|$)/, { timeout: 20_000 });
    await expect(page).not.toHaveURL(/claim=/);

    await context.close();
  });

  test("a path that is not a handle still redirects, as it always did", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/nao-existe-essa-rota");
    await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 15_000 });
    await context.close();
  });

  test("the public profile endpoint really does answer without a token", async () => {
    await ensureHandle();
    // No Authorization header. CLAUDE.md pitfall #8 says every /api route needs
    // one; this is one of the four that deliberately does not, and that
    // exception is the feature.
    const response = await fetch(`${API}/api/public/profiles/${HANDLE}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.profile).sort()).toEqual([
      "avatarUrl",
      "badges",
      "depoimentoCount",
      "displayName",
      "handle",
    ]);

    const missing = await fetch(`${API}/api/public/profiles/ninguem_aqui`);
    expect(missing.status).toBe(404);
  });
});
