import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Dialog geometry on a phone.
 *
 * The bug this suite exists for: on a real iPhone the "Start a conversation"
 * dialog rendered wider than the screen, so the eyebrow read "RECT MESSAGE" and
 * the title "tart a conversation" — the left edge was simply not on the
 * display. Nothing about it was detectable by asking whether the dialog opened,
 * which it always did. So every assertion here is a measurement: where the box
 * actually is, against where the screen actually ends.
 *
 * 390 is an iPhone 13/14/15; 320 is the narrowest phone still in use.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";

/**
 * Somebody for the people picker to find.
 *
 * The dev bypass mints an account per `dev-local-token:<suffix>`, and the
 * picker excludes the caller — so with only the suite's own account on the
 * database every search is empty, and "the results render inside the dialog"
 * would be measuring the *no matches* placeholder instead of a list. Merely
 * asking who this token is creates the row.
 */
async function ensureSearchablePeer(): Promise<void> {
  await fetch(`${API}/api/me`, {
    headers: { Authorization: "Bearer dev-local-token:pickerpeer" },
  });
}

const SIZES = [
  { label: "390", width: 390, height: 844 },
  { label: "320", width: 320, height: 568 },
] as const;

/** Sub-pixel rounding is not a layout bug. */
const SLACK = 0.5;

interface DialogBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  viewportWidth: number;
  viewportHeight: number;
  documentScrollWidth: number;
  footerBottom: number | null;
  footerLeft: number | null;
  bodyScrollable: boolean;
}

async function measureDialog(page: Page): Promise<DialogBox> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!panel) {
      throw new Error("no dialog panel on the page");
    }
    const rect = panel.getBoundingClientRect();
    const body = panel.children[1] as HTMLElement | undefined;
    const last = panel.lastElementChild as HTMLElement | null;
    const footer = last && last !== body ? last.getBoundingClientRect() : null;
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      footerBottom: footer ? footer.bottom : null,
      footerLeft: footer ? footer.left : null,
      bodyScrollable: body ? body.scrollHeight > body.clientHeight + 1 : false,
    };
  });
}

function expectInsideViewport(box: DialogBox, what: string): void {
  expect(box.left, `${what}: left edge is off the screen`).toBeGreaterThanOrEqual(-SLACK);
  expect(box.right, `${what}: right edge is off the screen`).toBeLessThanOrEqual(
    box.viewportWidth + SLACK,
  );
  expect(box.top, `${what}: top edge is off the screen`).toBeGreaterThanOrEqual(-SLACK);
  expect(box.bottom, `${what}: bottom edge is off the screen`).toBeLessThanOrEqual(
    box.viewportHeight + SLACK,
  );
  // A dialog that fits but leaves the page horizontally scrollable is still a
  // dialog you can swipe away from.
  expect(box.documentScrollWidth, `${what}: the page scrolls sideways`).toBeLessThanOrEqual(
    box.viewportWidth + SLACK,
  );
  if (box.footerBottom !== null) {
    expect(box.footerBottom, `${what}: the buttons are below the fold`).toBeLessThanOrEqual(
      box.viewportHeight + SLACK,
    );
    expect(box.footerLeft!, `${what}: the buttons start off the left edge`).toBeGreaterThanOrEqual(
      -SLACK,
    );
  }
}

/**
 * The sidebar is a drawer under `md`, and it or its backdrop covers whatever
 * the next click wants. Both helpers are no-ops when the drawer is already in
 * the state asked for, so a spec can just state what it needs.
 */
async function openDrawer(page: Page): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Close navigation" });
  if (await backdrop.isVisible()) {
    return;
  }
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(backdrop).toBeVisible();
  await page.waitForTimeout(350); // the drawer transition
}

async function closeDrawer(page: Page): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Close navigation" });
  if (!(await backdrop.isVisible())) {
    return;
  }
  await backdrop.click();
  await expect(backdrop).toBeHidden();
  await page.waitForTimeout(350);
}

/**
 * Every dialog reachable from a fresh account at phone width, and how to get
 * there. Four rather than one because the cause was in the shared primitive:
 * a fix that only proved the DM dialog would prove almost nothing.
 */
const DIALOGS: {
  name: string;
  title: RegExp;
  open: (page: Page) => Promise<void>;
}[] = [
  {
    name: "start a conversation",
    title: /Start a conversation/,
    open: async (page) => {
      await page.getByRole("button", { name: "Direct messages" }).click();
      await openDrawer(page);
      await page.getByRole("button", { name: "New message" }).first().click();
    },
  },
  {
    name: "pinned messages",
    title: /Pinned/i,
    open: async (page) => {
      await closeDrawer(page);
      await page.getByRole("button", { name: "Pins" }).first().click();
    },
  },
  {
    name: "channel topic",
    title: /./,
    open: async (page) => {
      await closeDrawer(page);
      await page.getByRole("button", { name: "Topic" }).first().click();
    },
  },
  {
    name: "settings",
    title: /Settings/i,
    open: async (page) => {
      await openDrawer(page);
      await page.getByRole("button", { name: "Open settings" }).first().click();
    },
  },
];

for (const size of SIZES) {
  test.describe(`dialogs at ${size.label}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const dialog of DIALOGS) {
      test(`${dialog.name} fits the viewport`, async ({ page }) => {
        await openApp(page);
        await dialog.open(page);
        await expect(page.getByRole("dialog")).toBeVisible();
        // `animate-rise` slides the panel up from below; measuring mid-flight
        // reports an overflow that is about to stop existing.
        await page.waitForTimeout(800);

        const box = await measureDialog(page);
        expectInsideViewport(box, `${dialog.name} @ ${size.label}`);
        expect(box.width).toBeLessThanOrEqual(size.width + SLACK);
      });
    }

    test("a dialog taller than the screen scrolls its body, not its buttons", async ({
      page,
    }) => {
      await openApp(page);
      await openDrawer(page);
      await page.getByRole("button", { name: "Open settings" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(800);

      const box = await measureDialog(page);
      // Settings is long enough to overflow any phone; if it ever stops being,
      // this assertion is what says so rather than quietly proving nothing.
      expect(box.bodyScrollable, "settings no longer overflows a phone").toBe(true);
      expectInsideViewport(box, `settings @ ${size.label}`);
    });

    test("the people picker's results render inside the dialog", async ({ page }) => {
      await ensureSearchablePeer();
      await openApp(page);
      await page.getByRole("button", { name: "Direct messages" }).click();
      await openDrawer(page);
      await page.getByRole("button", { name: "New message" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();

      const field = page.getByRole("combobox", { name: "Find people" });
      // Long enough to be a real query and short enough to match the seeded
      // peer's handle rather than nothing.
      await field.fill("dev");
      const results = page.getByRole("listbox", { name: "Find people" });
      await expect(results).toBeVisible();
      await expect(results.getByRole("option").first()).toBeVisible();
      await page.waitForTimeout(800);

      const geometry = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
        const menu = panel.querySelector<HTMLElement>('[role="listbox"]')!;
        const panelRect = panel.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        // Anything between the menu and the panel that clips is what used to
        // eat the results: an absolutely positioned menu is drawn *inside* the
        // dialog body's scroll box, so it was cut off at the body's edge.
        let clippedBy: string | null = null;
        for (
          let node = menu.parentElement;
          node && node !== panel.parentElement;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (style.overflowX === "visible" && style.overflowY === "visible") {
            continue;
          }
          const box = node.getBoundingClientRect();
          if (menuRect.bottom > box.bottom + 1 || menuRect.top < box.top - 1) {
            clippedBy = `${node.tagName}.${node.className}`;
            break;
          }
        }
        return {
          menu: { top: menuRect.top, bottom: menuRect.bottom, left: menuRect.left, right: menuRect.right },
          panel: { top: panelRect.top, bottom: panelRect.bottom, left: panelRect.left, right: panelRect.right },
          clippedBy,
          // Drawn above the panel's own background, not behind it.
          onTop: menu.contains(
            document.elementFromPoint(
              (menuRect.left + menuRect.right) / 2,
              menuRect.top + 4,
            ),
          ),
        };
      });

      expect(geometry.clippedBy, "the results list is cut off by a scroll box").toBeNull();
      expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.panel.top - SLACK);
      expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.panel.bottom + SLACK);
      expect(geometry.menu.left).toBeGreaterThanOrEqual(geometry.panel.left - SLACK);
      expect(geometry.menu.right).toBeLessThanOrEqual(geometry.panel.right + SLACK);
      expect(geometry.onTop, "something is painted over the results").toBe(true);

      const box = await measureDialog(page);
      expectInsideViewport(box, `start a conversation with results @ ${size.label}`);
    });

    test("dialog fields are big enough not to trigger iOS's focus zoom", async ({
      page,
    }) => {
      await openApp(page);
      await page.getByRole("button", { name: "Direct messages" }).click();
      await openDrawer(page);
      await page.getByRole("button", { name: "New message" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // Safari magnifies the whole page when focus lands on a field under 16px,
      // which is what pushed this dialog off the left of the screen: the layout
      // viewport keeps its width while the visible one shrinks.
      const fontSize = await page
        .getByRole("combobox", { name: "Find people" })
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
      expect(fontSize).toBeGreaterThanOrEqual(16);
    });
  });
}

test.describe("dialogs on a magnified page", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the dialog tracks the visible rectangle, not the layout viewport", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "page scale is set through CDP");

    await openApp(page);
    await page.getByRole("button", { name: "Direct messages" }).click();
    await openDrawer(page);
    await page.getByRole("button", { name: "New message" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(800);

    const cdp = await page.context().newCDPSession(page);
    // Exactly what iOS Safari does to a page holding a 14px field, and the same
    // shape of change the on-screen keyboard makes: the visual viewport shrinks
    // and scrolls while the layout viewport stays 390px wide.
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 16 / 14 });
    await cdp.send("Input.synthesizeScrollGesture", {
      x: 195,
      y: 400,
      xDistance: -25,
      yDistance: 0,
      gestureSourceType: "touch",
    });
    await page.waitForTimeout(500);

    const visible = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const rect = panel.getBoundingClientRect();
      const viewport = window.visualViewport!;
      return {
        scale: viewport.scale,
        offsetLeft: viewport.offsetLeft,
        clippedLeft: viewport.offsetLeft - rect.left,
        clippedRight: rect.right - (viewport.offsetLeft + viewport.width),
        clippedBottom: rect.bottom - (viewport.offsetTop + viewport.height),
      };
    });

    // Guard the guard: if the emulation stops taking effect the assertions
    // below would pass trivially.
    expect(visible.scale).toBeGreaterThan(1.1);
    expect(visible.offsetLeft).toBeGreaterThan(0);

    expect(visible.clippedLeft, "the left edge is outside the visible area").toBeLessThanOrEqual(
      SLACK,
    );
    expect(visible.clippedRight, "the right edge is outside the visible area").toBeLessThanOrEqual(
      SLACK,
    );
    expect(
      visible.clippedBottom,
      "the buttons are under the keyboard / outside the visible area",
    ).toBeLessThanOrEqual(SLACK);
  });
});

test.describe("dialog behaviour survives the layout fix", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("escape closes, focus is trapped and then restored, and the page cannot scroll", async ({
    page,
  }) => {
    await openApp(page);
    await closeDrawer(page);

    const trigger = page.getByRole("button", { name: "Pins" }).first();
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    // Focus starts inside and cannot be tabbed out of.
    await page.waitForTimeout(300);
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')!
          .contains(document.activeElement),
      );
      expect(inside, "focus escaped the dialog").toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await expect(trigger).toBeFocused();
  });
});
