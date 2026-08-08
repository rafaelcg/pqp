import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/**
 * A server's icon and banner, from the picker to the channel column.
 *
 * TWO HALVES, and which one runs depends on the deployment under test:
 *
 *  - the **no-storage** half always runs. It is not a lesser case: no
 *    deployment has `S3_*` today, so "there is no banner" is what every real
 *    channel column looks like and the layout has to be right without one.
 *  - the **upload** half needs a bucket. Bring one up with
 *    `docker compose --profile storage up -d postgres minio minio-init` and
 *    export `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` /
 *    `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE=true` before running the
 *    suite; `playwright.config.ts` passes them through to the API it boots.
 *    Without them this half skips rather than failing, because a suite that
 *    goes red for a service nobody asked for is a suite people stop running.
 *    The mint / HEAD / claim contract itself is pinned without any bucket in
 *    `server/src/api/server-images.test.ts` — what this adds is the part only a
 *    browser can prove: the crop, the direct-to-storage PUT, and the picture
 *    actually appearing in the column.
 */

/**
 * A real 8×4 PNG — deliberately the wrong shape for both an icon and a banner,
 * so the client's centre-crop is doing work rather than passing bytes through.
 * It has to actually decode: `createImageBitmap` is the only validation the
 * upload path has, and a malformed blob fails at the picker with "not an image
 * this browser can read" long before anything is signed.
 */
const PNG_8X4 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEUlEQVR4nGM4YWODFTFQTwIA4k0oATuABEUAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Whether the API under test has a bucket — asked once and remembered.
 *
 * Cached because it decides which half of this file runs, and a *flaky* answer
 * is far worse than either answer: half the tests would skip and the other half
 * would assert the opposite deployment shape, in the same run. It cannot change
 * while the suite is up — `S3_*` is read from the environment of a process
 * Playwright booted once — so one answer is the honest one. Retried for the
 * same reason: a single dropped connection must not silently reclassify the
 * deployment.
 */
let storageAnswer: boolean | null = null;

async function storageEnabled(): Promise<boolean> {
  if (storageAnswer !== null) {
    return storageAnswer;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API}/api/servers/images/config`, {
        headers: { Authorization: `Bearer ${DEV_TOKEN}` },
      });
      if (response.ok) {
        const { enabled } = (await response.json()) as { enabled: boolean };
        storageAnswer = enabled;
        return enabled;
      }
    } catch {
      // Fall through to the retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  storageAnswer = false;
  return false;
}

/**
 * The banner *in the channel column*, which is not the only one on the page:
 * the Identity section previews it with the very same component, deliberately,
 * so the preview and the thing previewed cannot disagree. `aside` is the column.
 */
const columnBanner = (page: Page) => page.locator("aside [data-server-banner]");

async function openServerSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Community settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** List (or unlist) the suite's own server in the public directory. */
async function setListed(isCommunity: boolean): Promise<void> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}`,
  };
  const response = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await response.json()) as {
    servers: { id: string; name: string }[];
  };
  const target = servers.find((s) => s.name === "E2E") ?? servers[0]!;
  await fetch(`${API}/api/servers/${target.id}/community`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ isCommunity }),
  });
}

/** Clear both pictures through the API, so a run starts from a known column. */
async function clearImages(): Promise<void> {
  const headers = { Authorization: `Bearer ${DEV_TOKEN}` };
  const response = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await response.json()) as { servers: { id: string }[] };
  for (const server of servers) {
    for (const kind of ["icon", "banner"]) {
      await fetch(`${API}/api/servers/${server.id}/${kind}`, {
        method: "DELETE",
        headers,
      });
    }
  }
}

test.describe("a server with no banner", () => {
  test("the channel column keeps the header it has always had", async ({
    page,
  }) => {
    if (await storageEnabled()) {
      await clearImages();
    }
    await openApp(page);

    // Nothing is drawn at all — not an empty band, not a placeholder. The
    // header underneath still names the server, which is the whole reason the
    // banner is allowed to be absent.
    await expect(columnBanner(page)).toHaveCount(0);
    await expect(page.getByText("E2E").first()).toBeVisible();
  });

  test("the identity controls say why when there is no storage", async ({
    page,
  }) => {
    test.skip(
      await storageEnabled(),
      "storage is configured — the upload controls are the other spec",
    );
    await openApp(page);
    await openServerSettings(page);

    // A sentence rather than a button that 503s.
    await expect(
      page.getByText(/no file storage configured/i),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("uploading a banner", () => {
  test.beforeEach(async () => {
    test.skip(
      !(await storageEnabled()),
      "no S3_* on the API under test — see the note at the top of this file",
    );
    await clearImages();
  });

  test("a picked file reaches the channel column and the rail", async ({
    page,
  }) => {
    await openApp(page);
    await openServerSettings(page);

    // The Identity block lives in Overview, which is the section the dialog
    // opens on for an owner.
    const banner = page.locator('[data-server-image="banner"]');
    await expect(banner).toBeVisible();

    await banner.locator('input[type="file"]').setInputFiles({
      name: "banner.png",
      mimeType: "image/png",
      buffer: PNG_8X4,
    });

    // The claim writes the row before this resolves, so the column behind the
    // dialog changes while it is still open — which is the point of a picture.
    await expect(columnBanner(page)).toBeVisible({
      timeout: 20_000,
    });

    const icon = page.locator('[data-server-image="icon"]');
    await icon.locator('input[type="file"]').setInputFiles({
      name: "icon.png",
      mimeType: "image/png",
      buffer: PNG_8X4,
    });
    await expect(
      icon.getByRole("button", { name: "Remove" }),
    ).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    const band = columnBanner(page);
    await expect(band).toBeVisible();
    // ~120px tall, which is the height the whole design assumes.
    expect((await band.boundingBox())!.height).toBeGreaterThan(100);
    await page.screenshot({ path: "/tmp/srv-banner-1440.png" });
  });

  test("removing it puts the column back", async ({ page }) => {
    await openApp(page);
    await openServerSettings(page);

    const banner = page.locator('[data-server-image="banner"]');
    await banner.locator('input[type="file"]').setInputFiles({
      name: "banner.png",
      mimeType: "image/png",
      buffer: PNG_8X4,
    });
    await expect(columnBanner(page)).toBeVisible({
      timeout: 20_000,
    });

    await banner.getByRole("button", { name: "Remove" }).click();
    await expect(columnBanner(page)).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});

test.describe("the pictures on a directory card", () => {
  test("a listed community shows its icon and its banner", async ({ page }) => {
    test.skip(
      !(await storageEnabled()),
      "no S3_* on the API under test — see the note at the top of this file",
    );
    await clearImages();
    await openApp(page);
    await openServerSettings(page);

    for (const kind of ["icon", "banner"]) {
      await page
        .locator(`[data-server-image="${kind}"] input[type="file"]`)
        .setInputFiles({
          name: `${kind}.png`,
          mimeType: "image/png",
          buffer: PNG_8X4,
        });
      await expect(
        page
          .locator(`[data-server-image="${kind}"]`)
          .getByRole("button", { name: "Remove" }),
      ).toBeVisible({ timeout: 20_000 });
    }

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Listed through the API rather than through the switch beside the upload:
    // the switch has its own spec (`communities.spec.ts`), and what is under
    // test here is the card, not the opt-in.
    await setListed(true);

    // Home, then the directory — the same two clicks a real user makes.
    await page.getByRole("button", { name: "Direct messages" }).click();
    await page.locator("[data-communities-nav]").click();
    await expect(page.locator("[data-communities-view]")).toBeVisible();
    // Searched rather than browsed: browsing applies `COMMUNITY_MEMBER_FLOOR`
    // and this server has exactly one member. Somebody typing the name is not
    // browsing, which is why search deliberately ignores the floor.
    await page
      .getByRole("searchbox", { name: "Search communities" })
      .fill("E2E");

    const card = page.locator("[data-community]").filter({ hasText: "E2E" });
    await expect(card).toBeVisible();
    await expect(card.locator("[data-community-banner]")).toBeVisible();
    await expect(card.locator("img").first()).toBeVisible();
    await page.screenshot({ path: "/tmp/srv-community-card.png" });

    // Unlisted again, so the directory is as empty as this spec found it —
    // `communities.spec.ts` asserts on exactly which cards are visible.
    await setListed(false);
  });
});

test.describe("a banner on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits the drawer and never scrolls the page sideways", async ({
    page,
  }) => {
    test.skip(
      !(await storageEnabled()),
      "no S3_* on the API under test — see the note at the top of this file",
    );
    await clearImages();
    await openApp(page);

    // The channel list is a drawer under `md`, and the settings button lives
    // inside it — so the drawer has to be open before anything else here.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForTimeout(350);
    await openServerSettings(page);
    await page
      .locator('[data-server-image="banner"] input[type="file"]')
      .setInputFiles({
        name: "banner.png",
        mimeType: "image/png",
        buffer: PNG_8X4,
      });
    await expect(columnBanner(page)).toBeVisible({
      timeout: 20_000,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.waitForTimeout(350);

    const geometry = await page.evaluate(() => ({
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      bannerWidth: document
        .querySelector("aside [data-server-banner]")!
        .getBoundingClientRect().width,
    }));
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(
      geometry.viewportWidth + 0.5,
    );
    expect(geometry.bannerWidth).toBeLessThanOrEqual(geometry.viewportWidth);

    await page.screenshot({ path: "/tmp/srv-banner-390.png" });
  });
});
