import { expect, test, type Page } from "@playwright/test";

/**
 * The server header, rebuilt per `docs/plans/SERVER_HEADER_REDO.md`: one
 * name, one line, ellipsis, a chevron that opens the server menu.
 *
 * Everything checkable from static markup — the banner strip's shape, the
 * name said once, no role word, the loading state — lives in
 * `src/components/layout/channel-list-header.test.tsx` (vitest). What is
 * here is what only a real browser can answer: truncation at an actual
 * pixel width with an actual font, and the menu opening, closing and
 * navigating on a real click and a real keystroke.
 *
 * Own suffixed accounts throughout (`materialiseAccount`), never the shared
 * dev-bypass account `fixtures.ts` seeds as "E2E" — this spec needs full
 * control over the server's name and community flag, and a shared server
 * would leak state between runs and between specs. `/app/server/:id`
 * (already used by `community-home.spec.ts`) skips the rail entirely, so a
 * test lands on its own server directly rather than clicking to find it.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/** The three sample names from spec §8, in the same order as the table. */
const SAMPLE_NAMES = [
  "PQP",
  "QG do pqp",
  "Comunidade dos Amigos do Rafael Que Gostam de Filmes",
] as const;

/** The identity row's height, spec §6.2 — `min-h-12`, and it never changes. */
const ROW_HEIGHT_PX = 48;

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/**
 * Every request here throws on a non-2xx response rather than pressing on —
 * a `beforeAll` that swallows a failed age-check or preferences write leaves
 * later tests running against a half-onboarded account, which fails in
 * whatever the FIRST thing to touch that gap happens to be, not in
 * `materialiseAccount` where the actual cause is.
 */
async function materialiseAccount(suffix: string): Promise<void> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  if (!me.ok) {
    throw new Error(`GET /api/me failed for suffix "${suffix}": ${me.status}`);
  }
  const body = (await me.json()) as { ageGate?: string };
  if (body.ageGate && body.ageGate !== "passed") {
    const ageCheck = await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
    if (!ageCheck.ok) {
      throw new Error(
        `age-check failed for suffix "${suffix}": ${ageCheck.status}`,
      );
    }
  }
  const preferences = await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  if (!preferences.ok) {
    throw new Error(
      `preferences PATCH failed for suffix "${suffix}": ${preferences.status}`,
    );
  }
}

async function createServer(
  suffix: string,
  name: string,
  opts: { community?: boolean } = {},
): Promise<string> {
  const headers = headersFor(suffix);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  if (!created.ok) {
    throw new Error(`could not create server "${name}": ${created.status}`);
  }
  const { server } = (await created.json()) as { server: { id: string } };
  if (opts.community) {
    const slug = `header-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${API}/api/servers/${server.id}/community`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ isCommunity: true, slug }),
    });
    if (!res.ok) {
      throw new Error(`could not address server as a community: ${res.status}`);
    }
  }
  return server.id;
}

/**
 * Opens `/app/server/:id` as `suffix`, with the channel sidebar's stored
 * width set BEFORE the app mounts — `useChannelSidebarWidth` reads
 * `localStorage` once on init, so setting it any later races the first
 * render.
 */
async function openServerAtWidth(
  page: Page,
  suffix: string,
  serverId: string,
  widthPx: number,
  options: { lang?: "en" | "pt-BR" } = {},
): Promise<void> {
  await page.addInitScript(
    ([suffixValue, width]) => {
      window.localStorage.setItem("pqp:dev-user-suffix", suffixValue as string);
      window.localStorage.setItem("pqp:channel-sidebar-width", String(width));
    },
    [suffix, widthPx] as const,
  );
  const langParam = options.lang ? `?lang=${options.lang}` : "";
  await page.goto(`/app/server/${serverId}${langParam}`);
  await page.locator("[data-server-header]").waitFor({ state: "visible" });
}

test.describe("server header: real truncation, one name box per width", () => {
  const suffix = `hdrw${Date.now()}`.slice(0, 20);
  const serverIdByName: Record<string, string> = {};

  test.beforeAll(async () => {
    await materialiseAccount(suffix);
    for (const name of SAMPLE_NAMES) {
      serverIdByName[name] = await createServer(suffix, name);
    }
  });

  for (const width of [200, 240, 256, 280, 320, 360, 420]) {
    for (const name of SAMPLE_NAMES) {
      test(`${width}px — "${name}" — one line, no mid-word clip, row stays ${ROW_HEIGHT_PX}px`, async ({
        page,
      }) => {
        await openServerAtWidth(page, suffix, serverIdByName[name]!, width);

        const header = page.locator("[data-server-header]").first();
        await expect(header).toBeVisible();

        // Row height never depends on the name.
        const box = await header.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.round(box!.height)).toBe(ROW_HEIGHT_PX);

        const nameHandle = page.locator("[data-server-name]").first();
        const metrics = await nameHandle.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            text: el.textContent ?? "",
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            overflow: style.overflowX || style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
          };
        });

        // The DOM text is always the full name — CSS truncates, JS never
        // slices the string (spec §8 rule 2 and 6).
        expect(metrics.text).toBe(name);
        // The three properties `truncate` sets, all at once (AC #3).
        expect(metrics.overflow).toBe("hidden");
        expect(metrics.textOverflow).toBe("ellipsis");
        expect(metrics.whiteSpace).toBe("nowrap");

        // Nothing in the header overflows the column (AC #5).
        const rowScroll = await header.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(rowScroll.scrollWidth).toBeLessThanOrEqual(rowScroll.clientWidth + 1);
      });
    }
  }

  test("the phone drawer (390px viewport) gets a 256px column with exactly two actions", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openServerAtWidth(page, suffix, serverIdByName["QG do pqp"]!, 256);
    const header = page.locator("[data-server-header]").first();
    await expect(header).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-server-name]").first()).toBeVisible();
    const actions = page.locator("[data-server-header-actions]").first();
    // `:visible`, not a bare `button` count: AC #21 is about what a viewer
    // can see, and a `hidden md:flex` collapse button sitting in the DOM
    // below `md` would inflate a plain node count to three without ever
    // being visible.
    await expect(actions.locator("button:visible")).toHaveCount(2);
    // Below `md`: close (×), not collapse — whether or not a collapse
    // button is present in the DOM at all, it must not be one of the two
    // visible controls.
    await expect(
      actions.locator("[data-channel-sidebar-toggle]:visible"),
    ).toHaveCount(0);
  });
});

test.describe("server header: the menu", () => {
  const suffix = `hdrm${Date.now()}`.slice(0, 20);
  let plainServerId = "";
  let communityServerId = "";

  test.beforeAll(async () => {
    await materialiseAccount(suffix);
    plainServerId = await createServer(suffix, "Menu QA");
    communityServerId = await createServer(suffix, "Menu QA Community", {
      community: true,
    });
  });

  test("opens on a click, closes on Escape, returns focus to the trigger", async ({
    page,
  }) => {
    await openServerAtWidth(page, suffix, plainServerId, 320);
    const trigger = page.locator("[data-server-menu-trigger]").first();
    await trigger.click();
    const menu = page.locator("[data-server-menu]");
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("data-state", "open");

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("ArrowDown from the trigger opens the menu with the first item focused", async ({
    page,
  }) => {
    await openServerAtWidth(page, suffix, plainServerId, 320);
    const trigger = page.locator("[data-server-menu-trigger]").first();
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.locator("[data-server-menu]");
    await expect(menu).toBeVisible();
    const firstItem = menu.locator("[data-menu-item]").first();
    await expect(firstItem).toBeFocused();
  });

  test("a non-community server's menu has no Público row", async ({ page }) => {
    await openServerAtWidth(page, suffix, plainServerId, 320);
    const trigger = page.locator("[data-server-menu-trigger]").first();
    await trigger.click();
    const menu = page.locator("[data-server-menu]");
    await expect(menu).toBeVisible();
    await expect(menu).not.toContainText("Público");
    await expect(page.locator("[data-server-menu-public]")).toHaveCount(0);
  });

  test("a community server's menu leads with a non-interactive Público row (pt-BR)", async ({
    page,
  }) => {
    await openServerAtWidth(page, suffix, communityServerId, 320, {
      lang: "pt-BR",
    });
    const trigger = page.locator("[data-server-menu-trigger]").first();
    await trigger.click();
    const menu = page.locator("[data-server-menu]");
    await expect(menu).toBeVisible();
    const publicRow = page.locator("[data-server-menu-public]");
    await expect(publicRow).toHaveText("Público");
    // Not focusable, does not close the menu when clicked.
    await publicRow.click({ force: true });
    await expect(menu).toBeVisible();
  });

  test("the same row reads 'Public' in English", async ({ page }) => {
    await openServerAtWidth(page, suffix, communityServerId, 320, {
      lang: "en",
    });
    const trigger = page.locator("[data-server-menu-trigger]").first();
    await trigger.click();
    await expect(page.locator("[data-server-menu-public]")).toHaveText(
      "Public",
    );
  });

  test("right-clicking the header opens the same items as the click-triggered menu", async ({
    page,
  }) => {
    await openServerAtWidth(page, suffix, plainServerId, 320);

    const trigger = page.locator("[data-server-menu-trigger]").first();
    await trigger.click();
    const dropdownItems = await page
      .locator("[data-server-menu] [data-menu-item]")
      .allTextContents();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-server-menu]")).toBeHidden();

    const header = page.locator("[data-server-header]").first();
    await header.click({ button: "right" });
    const contextMenu = page.locator("[data-context-menu]");
    await expect(contextMenu).toBeVisible();
    const contextItems = await contextMenu.locator("[data-menu-item]").allTextContents();

    expect(contextItems).toEqual(dropdownItems);
  });
});
