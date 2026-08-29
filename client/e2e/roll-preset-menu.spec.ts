import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The `/roll` dice menu, measured rather than counted.
 *
 * The bug: eight presets, each a full-width row with a die preview and a
 * sentence ("20-sided die"), inside a `max-h-64` box, inside a composer at the
 * bottom of an `overflow-hidden` shell. ~410px of options in 256px of menu, and
 * in a short pane even those 256px reached past the top of the pane and were
 * clipped there. On a Mac the scrollbar is an overlay, so it is invisible until
 * you are already scrolling: what the user saw was the last option or two and no
 * hint that six more existed. "Eight options are in the DOM" passed the whole
 * time. So every assertion here is a rectangle: where each option actually is,
 * against what would actually cut it off.
 */

const NOTATIONS = ["1d20", "1d4", "1d6", "2d6", "1d8", "1d10", "1d12", "1d100"];

/** Sub-pixel rounding is not a layout bug. */
const SLACK = 1;

/** Grid rows share a y-centre to within line-height rounding. */
const ROW_TOLERANCE_PX = 2;

interface OptionBox {
  /** The accessible name — "20-sided die · Default". */
  name: string;
  /** The visible caption under the die. */
  notation: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
  /** The ancestor scroll box that cuts this option off, if any. */
  clippedBy: string | null;
  /** Actually painted where it claims to be, not merely laid out there. */
  onTop: boolean;
}

/**
 * Under `md` the sidebar is a drawer, and it (or its backdrop) covers the
 * composer the next click is aimed at. A no-op on a desktop viewport.
 */
async function closeDrawer(page: Page): Promise<void> {
  const backdrop = page.getByRole("button", { name: "Close navigation" });
  if (!(await backdrop.isVisible())) {
    return;
  }
  await backdrop.click();
  await expect(backdrop).toBeHidden();
  await page.waitForTimeout(350); // the drawer transition
}

async function openRollMenu(page: Page) {
  await closeDrawer(page);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill("/roll");
  const menu = page.getByRole("listbox", { name: "Dice" });
  await expect(menu).toBeVisible();
  // The menu fades in and then measures the room it has; both are over well
  // inside this, and measuring mid-flight reports a box nothing is in yet.
  await page.waitForTimeout(500);
  return menu;
}

/**
 * Every option's rectangle, and what (if anything) clips it.
 *
 * The ancestor walk is the same one `dialog-mobile-layout.spec.ts` uses for the
 * people picker: an absolutely positioned menu is drawn *inside* any ancestor
 * that scrolls or hides its overflow, so "the element is visible" and "you can
 * see the element" are different questions and only the second one matters.
 */
async function measureOptions(page: Page): Promise<OptionBox[]> {
  return page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[role="listbox"]');
    if (!menu) {
      throw new Error("no dice menu on the page");
    }
    const options = [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
    return options.map((option) => {
      const rect = option.getBoundingClientRect();
      let clippedBy: string | null = null;
      for (
        let node: HTMLElement | null = option.parentElement;
        node;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.overflowX === "visible" && style.overflowY === "visible") {
          continue;
        }
        const box = node.getBoundingClientRect();
        if (
          rect.bottom > box.bottom + 1 ||
          rect.top < box.top - 1 ||
          rect.left < box.left - 1 ||
          rect.right > box.right + 1
        ) {
          clippedBy = `${node.tagName}.${node.className}`;
          break;
        }
      }
      if (!clippedBy && (rect.top < -1 || rect.bottom > window.innerHeight + 1)) {
        clippedBy = "the viewport";
      }
      const painted = document.elementFromPoint(
        (rect.left + rect.right) / 2,
        (rect.top + rect.bottom) / 2,
      );
      return {
        name: option.getAttribute("aria-label") ?? "",
        // The last child, not `textContent`: a d20's preview draws "20" on the
        // face, so the whole cell reads "201d20".
        notation: option.lastElementChild?.textContent?.trim() ?? "",
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
        clippedBy,
        onTop: Boolean(painted && option.contains(painted)),
      };
    });
  });
}

/**
 * Three shapes of pane. 1440×900 is the desk; 390×844 is a phone; 1024×400 is
 * the one that broke — a chat column with almost no room above the composer,
 * which is what the text channel looks like beside a voice call.
 */
const SIZES = [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "390x844", width: 390, height: 844 },
  { label: "1024x400", width: 1024, height: 400 },
] as const;

for (const size of SIZES) {
  test.describe(`the /roll dice menu at ${size.label}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("shows every preset without anything cutting one off", async ({ page }) => {
      await openApp(page);
      await openRollMenu(page);

      const boxes = await measureOptions(page);
      expect(boxes.map((box) => box.notation)).toEqual(NOTATIONS);

      for (const box of boxes) {
        expect(box.clippedBy, `${box.notation} is cut off by ${box.clippedBy}`).toBeNull();
        expect(box.width, `${box.notation} has no width`).toBeGreaterThan(0);
        expect(box.height, `${box.notation} has no height`).toBeGreaterThan(0);
        expect(box.onTop, `something is painted over ${box.notation}`).toBe(true);
        // The long name is what a screen reader and a tooltip still say, even
        // though the cell only draws the die and its notation.
        expect(box.name, `${box.notation} lost its name`).not.toBe("");
      }
    });

    test("is a grid of dice, not a column of sentences", async ({ page }) => {
      await openApp(page);
      const menu = await openRollMenu(page);
      const boxes = await measureOptions(page);

      // Rows, by shared y-centre. Eight in four columns is two; a column of
      // eight — the bug — would be eight.
      const centres = boxes.map((box) => (box.top + box.bottom) / 2);
      const rows = centres.reduce<number[]>((kept, centre) => {
        if (!kept.some((seen) => Math.abs(seen - centre) <= ROW_TOLERANCE_PX)) {
          kept.push(centre);
        }
        return kept;
      }, []);
      expect(rows.length, "the dice are stacked one per line again").toBeLessThanOrEqual(3);

      // …and the whole menu fits its own box, so no option is only reachable
      // through a scrollbar that macOS does not draw until you scroll.
      const scroll = await menu.evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }));
      expect(
        scroll.scrollHeight,
        "the menu still hides options behind an overlay scrollbar",
      ).toBeLessThanOrEqual(scroll.clientHeight + SLACK);
    });
  });
}

test.describe("keyboard on the dice grid", () => {
  test("arrows walk the grid by cell and by row, and Enter rolls", async ({ page }) => {
    await openApp(page);
    const menu = await openRollMenu(page);
    const composer = page.getByPlaceholder(/^Message /);

    // By accessible name: a d20's preview draws "20" on the face, so the cell's
    // text reads "201d20" and matching on it would be matching on the drawing.
    const selected = () =>
      menu.locator('[role="option"][aria-selected="true"]').first();
    await expect(selected()).toHaveAttribute("aria-label", /^20-sided die/);

    // Right is the next cell along the row.
    await composer.press("ArrowRight");
    await expect(selected()).toHaveAttribute("aria-label", "4-sided die");

    // Down is the cell below, four along in a four-wide grid.
    await composer.press("ArrowDown");
    await expect(selected()).toHaveAttribute("aria-label", "10-sided die");

    await composer.press("ArrowLeft");
    await expect(selected()).toHaveAttribute("aria-label", "8-sided die");

    // Enter on a highlighted preset rolls it, exactly as clicking the cell
    // does: the composer empties and the menu goes with it.
    await composer.press("Enter");
    await expect(page.getByRole("listbox", { name: "Dice" })).toBeHidden();
    await expect(composer).toHaveValue("");
  });

  test("Escape gives the arrow keys back to the caret", async ({ page }) => {
    await openApp(page);
    await openRollMenu(page);
    const composer = page.getByPlaceholder(/^Message /);

    await composer.press("Escape");
    await expect(page.getByRole("listbox", { name: "Dice" })).toBeHidden();

    await composer.press("ArrowLeft");
    const caret = await composer.evaluate(
      (node: HTMLTextAreaElement) => node.selectionStart,
    );
    expect(caret, "the menu is closed but still eating the arrow keys").toBe(4);
  });
});

test.describe("the other composer menus keep their rows", () => {
  test("slash commands are still a described list", async ({ page }) => {
    await openApp(page);
    await closeDrawer(page);
    const composer = page.getByPlaceholder(/^Message /);
    await composer.click();
    await composer.fill("/");

    const menu = page.getByRole("listbox", { name: "Slash commands" });
    await expect(menu).toBeVisible();
    // A row carries its description; a grid cell would only carry the name.
    await expect(menu.getByRole("option", { name: /^\/roll/ })).toBeVisible();
    await expect(menu.getByText("Roll a 20-sided die, or pick another")).toBeVisible();
  });

  test("emoji completion is still a list, and nothing clips it", async ({ page }) => {
    await openApp(page);
    await closeDrawer(page);
    const composer = page.getByPlaceholder(/^Message /);
    await composer.click();
    await composer.fill(":smi");

    const menu = page.getByRole("listbox", { name: "Emoji" });
    await expect(menu).toBeVisible();
    await page.waitForTimeout(500);

    const boxes = await measureOptions(page);
    expect(boxes.length).toBeGreaterThan(0);
    // Only the ones on screen have to be unclipped: a long emoji list scrolls
    // on purpose. The first is the one the keyboard starts on.
    expect(boxes[0]!.clippedBy).toBeNull();
    expect(boxes[0]!.onTop).toBe(true);
  });
});
