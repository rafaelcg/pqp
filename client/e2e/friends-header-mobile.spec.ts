import { expect, test, type Page } from "@playwright/test";

/**
 * The Friends header on a phone.
 *
 * The bug this suite exists for: at 390px the header's content was 533px wide
 * in a 318px column with nothing to scroll it, so "Pendentes" was cut to "Pe"
 * and the header's "Adicionar amigo" button sat entirely past the right edge.
 * The page itself did not scroll sideways, because an ancestor clips, so
 * nothing but a measurement notices. Every assertion here is one.
 *
 * A pending request is part of the setup on purpose: "Pendentes (1)" is the
 * widest the tab gets, and the shape the original report was worst in. The
 * spec runs in Portuguese because most people use it and its labels are the
 * longest: in English the 800px tablet column fits even without the fix, in
 * Portuguese it did not.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/** Sub-pixel rounding is not a layout bug. */
const SLACK = 0.5;

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/** Creates the account, clears the age gate and onboarding; returns its id. */
async function materialiseAccount(suffix: string): Promise<string> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { id: string; ageGate?: string };
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
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  return body.id;
}

interface HeaderBox {
  clientWidth: number;
  scrollWidth: number;
  viewportWidth: number;
  addFriendLeft: number;
  addFriendRight: number;
}

async function measureHeader(page: Page): Promise<HeaderBox> {
  return page.evaluate(() => {
    const tabs = document.querySelector<HTMLElement>('[role="tablist"]');
    const header = tabs?.closest("header");
    if (!tabs || !header) {
      throw new Error("no friends header on the page");
    }
    const add = [...header.querySelectorAll("button")].find(
      (one) => one.getAttribute("aria-expanded") !== null,
    );
    if (!add) {
      throw new Error("no Add friend button in the header");
    }
    const rect = add.getBoundingClientRect();
    return {
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      viewportWidth: window.innerWidth,
      addFriendLeft: rect.left,
      addFriendRight: rect.right,
    };
  });
}

// 390 is an iPhone 13/14/15; 320 is the narrowest phone still in use; 800 is
// a tablet where the DM sidebar is open and the column is ~470px.
const SIZES = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 800, height: 900 },
] as const;

for (const size of SIZES) {
  test(`friends header fits at ${size.width}px with a pending request`, async ({
    page,
  }) => {
    const me = `fhm-${size.width}-a`;
    const other = `fhm-${size.width}-b`;
    const myId = await materialiseAccount(me);
    await materialiseAccount(other);
    await fetch(`${API}/api/friends`, {
      method: "POST",
      headers: headersFor(other),
      body: JSON.stringify({ userId: myId }),
    });

    await page.setViewportSize(size);
    await page.addInitScript((value) => {
      localStorage.setItem("pqp:dev-user-suffix", value);
    }, me);
    await page.goto("/app/dm?lang=pt-BR");
    const pending = page.getByRole("tab", { name: /^Pendentes \(1\)$/ });
    await expect(pending).toBeVisible({ timeout: 20_000 });

    const box = await measureHeader(page);
    expect(box.scrollWidth, "the header overflows its column").toBeLessThanOrEqual(
      box.clientWidth + SLACK,
    );
    expect(box.addFriendRight, "Add friend is past the right edge").toBeLessThanOrEqual(
      box.viewportWidth + SLACK,
    );
    expect(box.addFriendLeft).toBeGreaterThanOrEqual(-SLACK);

    // The tabs may scroll sideways on the narrowest phones, but each one
    // must be reachable and usable: scroll it in, then use it.
    await pending.scrollIntoViewIfNeeded();
    await pending.click();
    await expect(pending).toHaveAttribute("aria-selected", "true");

    await page.locator("header").getByRole("button", { name: "Adicionar amigo" }).click();
    await expect(page.getByRole("combobox")).toBeVisible();
  });
}
