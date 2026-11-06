import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  domStats,
  firstVisibleArticle,
  loadAllHistory,
  openChannel,
  placementOf,
  readUpTo,
  seedLongChannel,
  sendAs,
  type LongChannel,
} from "./message-window-helpers";

/**
 * The windowed transcript (`message_list_windowing`, on by default), with a
 * channel of two thousand messages.
 *
 * The old list mounted every loaded row: about fifty DOM nodes and 175 KB of
 * heap each, so a long channel held a gigabyte and a hundred thousand nodes.
 * These specs pin what must hold now that only the rows near the viewport are
 * mounted: the DOM stays bounded, and nothing a reader relies on moved while it
 * changed shape (permalinks, the NEW rule, the place they were reading when
 * older history arrives or a row above them changes height, the live end, the
 * keyboard, a selection, the log's semantics). The unit math is
 * `src/lib/message-window.test.ts`; the kill switch is in
 * `message-hover-toolbar.spec.ts`.
 *
 * Seeded by one INSERT (`message-window-helpers.ts`): a socket sends twenty
 * messages a second, and two thousand would be two minutes of setup.
 */

const COUNT = 2000;
/** The ceiling the work was done for: 100,743 nodes before, 2,000 messages. */
const NODE_BUDGET = 15_000;

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

const frames = (page: Page, count = 2) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);

const scrollTo = (page: Page, top: number | "end") =>
  page.evaluate((top) => {
    const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
    scroller.scrollTop = top === "end" ? scroller.scrollHeight : top;
  }, top);

const scrollBy = (page: Page, delta: number) =>
  page.evaluate((delta) => {
    document.querySelector<HTMLElement>('[role="log"]')!.scrollTop += delta;
  }, delta);

const newestArticle = (page: Page) =>
  page.locator('[role="log"] article[aria-label*="the reply"]');

/** Where the viewport is, read twice a pause apart: a settled scroll does not move. */
async function settledScrollTop(page: Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 20; i += 1) {
    const now = await page.evaluate(
      () => document.querySelector<HTMLElement>('[role="log"]')!.scrollTop,
    );
    if (Math.abs(now - last) < 1) {
      return now;
    }
    last = now;
    await page.waitForTimeout(150);
  }
  return last;
}

test.describe("windowed message list", () => {
  let seeded: LongChannel;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    seeded = await seedLongChannel(COUNT);
  });

  test.describe("with the whole history loaded", () => {
    // One page for the group: paging two thousand messages in is the slow part.
    test.describe.configure({ mode: "serial" });
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(180_000);
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        colorScheme: "dark",
      });
      page = await context.newPage();
      await openChannel(page, seeded, seeded.owner);
      await expect(newestArticle(page)).toBeAttached({ timeout: 30_000 });
      await loadAllHistory(page);
    });

    test.afterAll(async () => {
      await context.close();
    });

    test("two thousand loaded messages keep the DOM bounded", async () => {
      await scrollTo(page, "end");
      await frames(page, 4);
      const stats = await domStats(page);
      // Everything is loaded (the transcript is as tall as two thousand rows)
      // and almost none of it is mounted.
      expect(stats.scrollHeight).toBeGreaterThan(COUNT * 30);
      expect(stats.articles).toBeLessThan(250);
      expect(stats.articles).toBeGreaterThan(5);
      expect(stats.mountedRows).toBeGreaterThan(5);
      expect(stats.nodes).toBeLessThan(NODE_BUDGET);
    });

    test("sweeping the whole transcript never shows a blank viewport", async () => {
      await scrollTo(page, "end");
      await frames(page);
      const total = (await domStats(page)).scrollHeight;
      for (let top = total; top > 0; top -= 2200) {
        await scrollTo(page, top);
        await frames(page);
        const visible = await firstVisibleArticle(page);
        expect(visible, `rows mounted at ${Math.round(top)}px`).not.toBeNull();
        const { nodes, articles } = await domStats(page);
        expect(nodes).toBeLessThan(NODE_BUDGET);
        expect(articles).toBeLessThan(250);
      }
      // The first message is reachable, and the top really is the top.
      await scrollTo(page, 0);
      await expect(
        page.locator('[role="log"] article[aria-label*="msg 0 "]'),
      ).toBeVisible();
    });

    test("a pane made much taller while following the tail mounts the rows it now shows", async () => {
      // Maximising a window, a call dock closing, a tablet turning: the list is
      // on the tail, so the window comes from the end of the list, and nothing
      // but the height change itself can say it must grow. It used to leave a
      // blank spacer above the mounted rows until the next scroll.
      await page.setViewportSize({ width: 1440, height: 600 });
      await scrollTo(page, "end");
      await frames(page, 4);
      const blankAboveRows = () =>
        page.evaluate(() => {
          const log = document.querySelector<HTMLElement>('[role="log"]')!;
          const top = log.getBoundingClientRect().top;
          const first = Array.from(log.querySelectorAll("[data-row-id]"))
            .map((row) => row.getBoundingClientRect())
            .filter((rect) => rect.bottom > top)
            .sort((a, b) => a.top - b.top)[0];
          return first ? Math.max(0, first.top - top) : 9999;
        });
      try {
        await page.setViewportSize({ width: 1440, height: 2400 });
        await frames(page, 4);
        expect(await blankAboveRows()).toBeLessThan(60);
        expect(await firstVisibleArticle(page)).not.toBeNull();
        // Still on the tail, and still bounded.
        await expect
          .poll(async () => (await placementOf(page, COUNT))?.distanceFromBottom ?? 9999)
          .toBeLessThan(40);
        expect((await domStats(page)).nodes).toBeLessThan(NODE_BUDGET);
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
        await frames(page, 2);
      }
    });

    test("a reply quote jumps to a loaded message far outside the window", async () => {
      await scrollTo(page, "end");
      await frames(page, 4);
      expect(await placementOf(page, 10)).toBeNull();
      await newestArticle(page)
        .getByRole("button", { name: /Jump to .*'s message/ })
        .click();
      // Centred and kept there (the jump is re-centred once the rows between
      // have taken their real height), not just scrolled towards.
      await expect
        .poll(async () => Math.abs((await placementOf(page, 10))?.offCentre ?? 9999), {
          timeout: 10_000,
        })
        .toBeLessThanOrEqual(30);
      await page.waitForTimeout(1_500);
      const settled = (await placementOf(page, 10))!;
      expect(Math.abs(settled.offCentre)).toBeLessThanOrEqual(30);
      expect((await domStats(page)).articles).toBeLessThan(250);
    });

    test("focus is not lost when the focused row scrolls out of the window", async () => {
      await scrollTo(page, 0);
      await frames(page, 3);
      const row = page.locator('[role="log"] article[aria-label*="msg 3 "]');
      await row.focus();
      await expect(row).toBeFocused();
      // Far enough that every other mounted row has been replaced.
      await scrollTo(page, "end");
      await frames(page, 6);
      await page.waitForTimeout(300);
      await expect(row).toBeAttached();
      await expect(row).toBeFocused();
      // And it is still the log's one tab stop.
      await expect(
        page.locator('[role="log"] article[tabindex="0"]'),
      ).toHaveCount(1);
    });

    test("Home and End move the keyboard to rows that are not mounted", async () => {
      await scrollTo(page, "end");
      await frames(page, 4);
      await newestArticle(page).focus();
      await page.keyboard.press("ArrowUp");
      await expect(
        page.locator('[role="log"] article:focus'),
      ).toHaveAttribute("aria-label", /msg 1999 /);
      await page.keyboard.press("Home");
      await expect(
        page.locator('[role="log"] article:focus'),
      ).toHaveAttribute("aria-label", /msg 0 /, { timeout: 10_000 });
      // It is where the reader is looking, too, not only focused.
      await expect
        .poll(async () => (await placementOf(page, 0))?.top ?? 9999)
        .toBeLessThan(120);
      await page.keyboard.press("End");
      await expect(
        page.locator('[role="log"] article:focus'),
      ).toHaveAttribute("aria-label", /the reply/, { timeout: 10_000 });
      await expect
        .poll(async () => (await placementOf(page, COUNT))?.distanceFromBottom ?? 9999)
        .toBeLessThan(40);
    });

    test("a text selection keeps the rows it spans mounted", async () => {
      await scrollTo(page, "end");
      await frames(page, 4);
      // From a row near the top of the viewport to one near the bottom, set by
      // script: dragging with the mouse is the same selection.
      const spanned = await page.evaluate(() => {
        const articles = Array.from(
          document.querySelectorAll<HTMLElement>('[role="log"] article'),
        );
        const from = articles[articles.length - 30]!;
        const to = articles[articles.length - 6]!;
        const range = document.createRange();
        range.setStartBefore(from);
        range.setEndAfter(to);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return {
          from: from.getAttribute("aria-label"),
          to: to.getAttribute("aria-label"),
        };
      });
      await page.waitForTimeout(300);
      await scrollTo(page, 0);
      await frames(page, 6);
      await page.waitForTimeout(300);
      // Nowhere near the viewport now, still mounted, still selected.
      const kept = await page.evaluate((spanned) => {
        const labels = Array.from(
          document.querySelectorAll('[role="log"] article'),
        ).map((one) => one.getAttribute("aria-label"));
        return {
          from: labels.includes(spanned.from),
          to: labels.includes(spanned.to),
          selected: document.getSelection()!.toString().length,
        };
      }, spanned);
      expect(kept.from).toBe(true);
      expect(kept.to).toBe(true);
      expect(kept.selected).toBeGreaterThan(100);
      // Releasing it lets the window drop them again.
      await page.evaluate(() => document.getSelection()!.removeAllRanges());
      await page.waitForTimeout(400);
      await scrollBy(page, 1);
      await frames(page, 3);
      expect((await domStats(page)).articles).toBeLessThan(250);
    });

    test("the log keeps its semantics: a named log, ordered articles, one place in the set each", async () => {
      await scrollTo(page, 1800);
      await frames(page, 4);
      await expect(
        page.getByRole("log", { name: "Messages" }),
      ).toHaveCount(1);
      const posinsets = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="log"] article')).map(
          (one) => [
            one.getAttribute("aria-posinset"),
            one.getAttribute("aria-setsize"),
          ],
        ),
      );
      expect(posinsets.length).toBeGreaterThan(5);
      const positions = posinsets.map(([pos]) => Number(pos));
      expect(positions.every((pos) => Number.isInteger(pos) && pos > 0)).toBe(true);
      // DOM order is reading order, which is what a screen reader walks.
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      // The total is unknown: older history is paged in as people scroll.
      expect(posinsets.every(([, size]) => size === "-1")).toBe(true);
    });
  });

  test("a permalink to a message that is not loaded lands on it and stays", async ({
    page,
  }) => {
    await openChannel(
      page,
      seeded,
      seeded.owner,
      `/message/${seeded.ids.get(1200)}`,
    );
    await expect(
      page.locator('[role="log"] article[aria-label*="msg 1200 "]'),
    ).toBeAttached({ timeout: 30_000 });
    await expect
      .poll(async () => Math.abs((await placementOf(page, 1200))?.offCentre ?? 9999), {
        timeout: 10_000,
      })
      .toBeLessThanOrEqual(30);
    await page.waitForTimeout(1_800);
    const settled = (await placementOf(page, 1200))!;
    expect(Math.abs(settled.offCentre)).toBeLessThanOrEqual(30);
    // Parked in history, not pulled back to the tail.
    expect(settled.distanceFromBottom).toBeGreaterThan(120);
    expect((await domStats(page)).nodes).toBeLessThan(NODE_BUDGET);
  });

  test("scrolling away from a permalink and settling does not drift", async ({
    page,
  }) => {
    await openChannel(
      page,
      seeded,
      seeded.owner,
      `/message/${seeded.ids.get(700)}`,
    );
    await expect(
      page.locator('[role="log"] article[aria-label*="msg 700 "]'),
    ).toBeAttached({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    for (const delta of [-6000, 9000, -3000]) {
      await scrollBy(page, delta);
      await frames(page, 4);
      await page.waitForTimeout(400);
      // Rows mounted on the way took their real height above the reader, and
      // the row at the top of the viewport has not moved since.
      const first = await firstVisibleArticle(page);
      expect(first).not.toBeNull();
      await page.waitForTimeout(1_000);
      const later = await firstVisibleArticle(page);
      expect(later!.n).toBe(first!.n);
      expect(Math.abs(later!.top - first!.top)).toBeLessThanOrEqual(1);
    }
  });

  test("the NEW rule is landed on and the rows around it are mounted", async ({
    page,
  }) => {
    await readUpTo(seeded, seeded.guest, 1960);
    await openChannel(page, seeded, seeded.guest);
    const rule = page.locator('[role="separator"][aria-label="New"]');
    await expect(rule).toBeVisible({ timeout: 30_000 });
    // In the middle third of the transcript, not at the bottom where the list
    // otherwise opens.
    await expect
      .poll(async () =>
        rule.evaluate((node) => {
          const scroller = node.closest<HTMLElement>('[role="log"]')!;
          const box = scroller.getBoundingClientRect();
          const rect = node.getBoundingClientRect();
          return (rect.top - box.top) / box.height;
        }),
      )
      .toBeGreaterThan(0.15);
    await page.waitForTimeout(800);
    await expect(rule).toBeVisible();
    // The rows the rule sits among are mounted: the first unread message is
    // under it.
    await expect(rule.locator("xpath=following::article[1]")).toBeVisible();
  });

  test("older history arriving above the reader does not move the row they are on", async ({
    page,
  }) => {
    await openChannel(page, seeded, seeded.owner);
    await expect(newestArticle(page)).toBeAttached({ timeout: 30_000 });
    await frames(page, 4);
    const result = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const pick = () => {
        const box = scroller.getBoundingClientRect();
        for (const row of Array.from(scroller.querySelectorAll("article"))) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom > box.top + 1) {
            return {
              label: row.getAttribute("aria-label") ?? "",
              top: rect.top - box.top,
            };
          }
        }
        return null;
      };
      const before = scroller.scrollHeight;
      scroller.scrollTop = 140; // within the 240px that asks for older history
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const at = pick();
      const deadline = Date.now() + 10_000;
      while (scroller.scrollHeight <= before + 300 && Date.now() < deadline) {
        await sleep(50);
      }
      // The hold lasts 1.5 s while the new rows take their real height.
      await sleep(1_800);
      const box = scroller.getBoundingClientRect();
      const same = Array.from(scroller.querySelectorAll("article")).find(
        (row) => row.getAttribute("aria-label") === at?.label,
      );
      return {
        grew: scroller.scrollHeight - before,
        at,
        after: same ? same.getBoundingClientRect().top - box.top : null,
      };
    });
    expect(result.at).not.toBeNull();
    expect(result.grew).toBeGreaterThan(300);
    expect(result.after).not.toBeNull();
    expect(Math.abs(result.after! - result.at!.top)).toBeLessThanOrEqual(3);
  });

  test("a row above the reader growing (an image loading) does not move what they read", async ({
    page,
  }) => {
    await openChannel(
      page,
      seeded,
      seeded.owner,
      `/message/${seeded.ids.get(700)}`,
    );
    await expect(
      page.locator('[role="log"] article[aria-label*="msg 700 "]'),
    ).toBeAttached({ timeout: 30_000 });
    // Settled: centred, and still centred a pause later (the jump re-centres
    // itself while the rows between take their real height).
    await expect
      .poll(async () => Math.abs((await placementOf(page, 700))?.offCentre ?? 9999), {
        timeout: 10_000,
      })
      .toBeLessThanOrEqual(30);
    await page.waitForTimeout(2_000);
    await settledScrollTop(page);
    const before = (await placementOf(page, 700))!;
    // A row well above the viewport but mounted (overscan) takes 500px more,
    // the way a late image does.
    await page.evaluate(() => {
      const articles = Array.from(
        document.querySelectorAll<HTMLElement>('[role="log"] article'),
      );
      const target = articles.find((one) =>
        (one.getAttribute("aria-label") ?? "").includes("msg 700 "),
      )!;
      const index = articles.indexOf(target);
      const above = articles[Math.max(0, index - 14)]!;
      above.style.minHeight = `${above.getBoundingClientRect().height + 500}px`;
    });
    await frames(page, 6);
    await page.waitForTimeout(300);
    const after = (await placementOf(page, 700))!;
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
  });

  test("a message from somebody else follows at the live end, and does not drag a reader in history", async ({
    page,
  }) => {
    await openChannel(page, seeded, seeded.owner);
    await expect(newestArticle(page)).toBeAttached({ timeout: 30_000 });
    await expect
      .poll(async () => (await placementOf(page, COUNT))?.distanceFromBottom ?? 9999)
      .toBeLessThanOrEqual(4);

    // At the end the list follows.
    await sendAs(seeded.other, seeded.channelId, "live arrival one");
    const arrival = page.locator('[role="log"] article[aria-label*="live arrival one"]');
    await expect(arrival).toBeAttached();
    await expect
      .poll(() =>
        arrival.evaluate((node) => {
          const scroller = node.closest<HTMLElement>('[role="log"]')!;
          return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        }),
      )
      .toBeLessThanOrEqual(4);

    // Up in history it does not, and says so. Not so far up that older history
    // is asked for (within 240px of the top): a page in flight when the message
    // lands is counted as arrivals, a race that is the list's own and older.
    await scrollBy(page, -1000);
    await frames(page, 4);
    const parked = await settledScrollTop(page);
    await sendAs(seeded.other, seeded.channelId, "live arrival two");
    await expect(
      page.getByRole("button", { name: /1 new message/ }),
    ).toBeVisible();
    expect(Math.abs((await settledScrollTop(page)) - parked)).toBeLessThanOrEqual(2);

    // And the button takes them to it.
    await page.getByRole("button", { name: /1 new message/ }).click();
    await expect
      .poll(async () => {
        const row = page.locator('[role="log"] article[aria-label*="live arrival two"]');
        return (await row.count()) === 0
          ? 9999
          : row.evaluate((node) => {
              const scroller = node.closest<HTMLElement>('[role="log"]')!;
              return (
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
              );
            });
      }, { timeout: 10_000 })
      .toBeLessThanOrEqual(4);
  });

  test("the hover toolbar is built on the first hover, not for every row", async ({
    page,
  }) => {
    await openChannel(page, seeded, seeded.owner);
    await expect(newestArticle(page)).toBeAttached({ timeout: 30_000 });
    const row = page.locator('[role="log"] article[aria-label*="msg 1995 "]');
    // Six tooltips and their anchors, per row, are what a long channel paid for.
    await expect(row.locator(".group-hover\\:flex")).toHaveCount(0);
    await row.hover();
    await expect(row.locator(".group-hover\\:flex")).toHaveCount(1);
    await expect(
      row.getByRole("button", { name: /Reply/ }),
    ).toBeVisible();
    // Keyboard focus builds it too.
    const other = page.locator('[role="log"] article[aria-label*="msg 1993 "]');
    await expect(other.locator(".group-hover\\:flex")).toHaveCount(0);
    await other.focus();
    await expect(other.locator(".group-hover\\:flex")).toHaveCount(1);
  });
});
