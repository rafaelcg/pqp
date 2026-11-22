// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForumAnnouncementHint } from "./forum-announcement-hint";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  localStorage.clear();
});

const card = () => document.querySelector('[data-corner-card="forum-announcement"]');
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((one) => one.textContent === label)!;

describe("the forum announcement card", () => {
  it("draws nothing and writes nothing while it does not hold the corner", async () => {
    const onShowingChange = vi.fn();
    await mount(
      <ForumAnnouncementHint
        enabled={false}
        onShowingChange={onShowingChange}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(card()).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(onShowingChange).toHaveBeenLastCalledWith(false);
  });

  it("is a labelled landmark with a title, one line and two actions, not a live region", async () => {
    const onShowingChange = vi.fn();
    await mount(
      <ForumAnnouncementHint
        enabled
        onShowingChange={onShowingChange}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const aside = card()!;
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.getAttribute("aria-label")).toBe("The forum is open");
    expect(aside.getAttribute("role")).toBeNull();
    expect(aside.textContent).toContain("one topic per post");
    expect(button("Open the forum")).toBeTruthy();
    expect(button("Not now")).toBeTruthy();
    expect(aside.querySelector('button[aria-label="Dismiss the forum notice"]')).not.toBeNull();
    // Painting is not an impression: only an action stamps the server.
    expect(localStorage.length).toBe(0);
    expect(onShowingChange).toHaveBeenLastCalledWith(true);
  });

  it("Open the forum opens it, and does not count as a dismissal", async () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    await mount(<ForumAnnouncementHint enabled onOpen={onOpen} onDismiss={onDismiss} />);
    await act(async () => button("Open the forum").click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Not now, the X and Escape each dismiss it", async () => {
    const onDismiss = vi.fn();
    await mount(<ForumAnnouncementHint enabled onOpen={vi.fn()} onDismiss={onDismiss} />);
    await act(async () => button("Not now").click());
    await act(async () =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the forum notice"]')!.click(),
    );
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });

  it("a keyboard user who tabbed in gets focus back where they came from on dismiss", async () => {
    const before = document.createElement("button");
    before.textContent = "channel";
    document.body.append(before);
    await mount(<ForumAnnouncementHint enabled onOpen={vi.fn()} onDismiss={vi.fn()} />);
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
