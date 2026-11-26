// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JamAnnouncementHint, resetJamAnnouncementViewForTests } from "./jam-announcement-hint";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const umami = { track: vi.fn() };

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  umami.track.mockClear();
  (window as unknown as { umami?: typeof umami }).umami = umami;
  resetJamAnnouncementViewForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  localStorage.clear();
  delete (window as unknown as { umami?: typeof umami }).umami;
});

const card = () => document.querySelector('[data-corner-card="jam-announcement"]');
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((one) => one.textContent === label)!;
const events = () => umami.track.mock.calls.map((call) => call[0]);

describe("the Jam announcement card", () => {
  it("draws nothing, writes nothing and counts nothing while it does not hold the corner", async () => {
    const onShowingChange = vi.fn();
    await mount(
      <JamAnnouncementHint
        enabled={false}
        hasSong
        onShowingChange={onShowingChange}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(card()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(events()).toEqual([]);
    expect(onShowingChange).toHaveBeenLastCalledWith(false);
  });

  it("is a labelled landmark with the picture, a title, one line and two actions, not a live region", async () => {
    await mount(<JamAnnouncementHint enabled hasSong onOpen={vi.fn()} onDismiss={vi.fn()} />);
    const aside = card()!;
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.getAttribute("aria-label")).toBe("The Jam is open");
    expect(aside.getAttribute("role")).toBeNull();
    expect(aside.textContent).toContain("plays like a band");
    expect(button("Hear a jam")).toBeTruthy();
    expect(button("Not now")).toBeTruthy();
    expect(aside.querySelector('button[aria-label="Dismiss the Jam notice"]')).not.toBeNull();
    // The Jam how-to picture is the hero.
    expect(aside.querySelector(".jam-howto-lane")).not.toBeNull();
    // Painting is not an impression: only an action stamps the browser.
    expect(localStorage.length).toBe(0);
  });

  it("with no public song the primary button offers starting one", async () => {
    await mount(<JamAnnouncementHint enabled hasSong={false} onOpen={vi.fn()} onDismiss={vi.fn()} />);
    expect(button("Start a jam")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Hear a jam");
  });

  it("counts one view per load, however often it comes back", async () => {
    await mount(<JamAnnouncementHint enabled hasSong onOpen={vi.fn()} onDismiss={vi.fn()} />);
    await act(async () => {
      root!.render(<JamAnnouncementHint enabled={false} hasSong onOpen={vi.fn()} onDismiss={vi.fn()} />);
    });
    await act(async () => {
      root!.render(<JamAnnouncementHint enabled hasSong onOpen={vi.fn()} onDismiss={vi.fn()} />);
    });
    expect(events().filter((name) => name === "jam_news_view")).toHaveLength(1);
  });

  it("the primary button opens, counts a click and is not a dismissal", async () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    await mount(<JamAnnouncementHint enabled hasSong onOpen={onOpen} onDismiss={onDismiss} />);
    await act(async () => button("Hear a jam").click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(events()).toEqual(["jam_news_view", "jam_news_click"]);
  });

  it("Not now, the X and Escape each dismiss it and count a dismissal", async () => {
    const onDismiss = vi.fn();
    await mount(<JamAnnouncementHint enabled hasSong onOpen={vi.fn()} onDismiss={onDismiss} />);
    await act(async () => button("Not now").click());
    await act(async () =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the Jam notice"]')!.click(),
    );
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(3);
    expect(events().filter((name) => name === "jam_news_dismiss")).toHaveLength(3);
  });

  it("a keyboard user who tabbed in gets focus back where they came from on dismiss", async () => {
    const before = document.createElement("button");
    before.textContent = "channel";
    document.body.append(before);
    await mount(<JamAnnouncementHint enabled hasSong onOpen={vi.fn()} onDismiss={vi.fn()} />);
    before.focus();
    const later = button("Not now");
    await act(async () => {
      later.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: before }));
      later.focus();
    });
    await act(async () => later.click());
    expect(document.activeElement).toBe(before);
  });
});
