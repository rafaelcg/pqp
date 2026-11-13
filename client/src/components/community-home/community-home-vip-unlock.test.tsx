// @vitest-environment jsdom
import type { CommunityLink } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VipUnlockCard } from "./community-home-vip-unlock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * The locked card's three states. Rendered with no I18nProvider, so the
 * strings are the English fallback.
 */

const page: CommunityLink = { kind: "support", url: "https://livepix.gg/rafa" };
const pix: CommunityLink = { kind: "support", pix: "rafa@pqp.gg" };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

describe("VipUnlockCard", () => {
  it("with no support link there is no button, only who to ask", () => {
    const html = renderToStaticMarkup(<VipUnlockCard support={null} />);
    expect(html).toContain("data-home-unlock-cta");
    expect(html).toContain('data-home-unlock-support="0"');
    expect(html).toContain("VIP unlocks the supporter-only posts.");
    expect(html).toContain("Ask whoever runs the server for the VIP role.");
    expect(html).not.toContain("data-home-support-cta");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    // Nothing promises rooms the client cannot know exist.
    expect(html.toLowerCase()).not.toContain("voice");
    expect(html.toLowerCase()).not.toContain("watch party");
  });

  it("treats a support link with neither url nor pix as no link", () => {
    const html = renderToStaticMarkup(
      <VipUnlockCard support={{ kind: "support" }} />,
    );
    expect(html).not.toContain("data-home-support-cta");
  });

  it("a page opens in a new tab without leaking the opener", () => {
    const html = renderToStaticMarkup(<VipUnlockCard support={page} />);
    expect(html).toContain('href="https://livepix.gg/rafa"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("data-home-support-cta");
    expect(html).toContain("(opens in a new tab)");
    expect(html).toContain(
      "After you support, ask whoever runs the server for the VIP role.",
    );
    expect(html).not.toContain("Ask whoever runs the server for the VIP role.</p>");
  });

  it("reports one view and a click", async () => {
    const onView = vi.fn();
    const onSupportClick = vi.fn();
    const el = await mount(
      <VipUnlockCard
        support={page}
        onView={onView}
        onSupportClick={onSupportClick}
      />,
    );
    expect(onView).toHaveBeenCalledTimes(1);
    const link = el.querySelector<HTMLAnchorElement>("[data-home-support-cta]")!;
    // jsdom does not navigate on a click; the handler still runs.
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () => link.click());
    expect(onSupportClick).toHaveBeenCalledTimes(1);
    // Redrawing the same card is not another view.
    await act(async () =>
      root!.render(
        <VipUnlockCard support={page} onView={onView} onSupportClick={onSupportClick} />,
      ),
    );
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it("a card without a support link reports no view", async () => {
    const onView = vi.fn();
    await mount(<VipUnlockCard support={null} onView={onView} />);
    expect(onView).not.toHaveBeenCalled();
  });

  it("Pix is a disclosure button, never a link", async () => {
    const onSupportClick = vi.fn();
    const el = await mount(
      <VipUnlockCard support={pix} onSupportClick={onSupportClick} />,
    );
    expect(el.querySelector("a")).toBeNull();
    const button = el.querySelector<HTMLButtonElement>("[data-home-support-cta]")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector("[data-home-support-pix]")).toBeNull();

    await act(async () => button.click());
    expect(onSupportClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = el.querySelector("[data-home-support-pix]")!;
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.querySelector("[data-home-support-pix-text]")?.textContent).toBe(
      "rafa@pqp.gg",
    );
    expect(panel.textContent).toContain("Copy Pix");
    // Still no anchor anywhere, whatever the text looks like.
    expect(el.querySelector("a")).toBeNull();

    // Escape closes it and gives focus back.
    await act(async () => {
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(el.querySelector("[data-home-support-pix]")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("copies the Pix text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const el = await mount(<VipUnlockCard support={pix} />);
    await act(async () =>
      el.querySelector<HTMLButtonElement>("[data-home-support-cta]")!.click(),
    );
    const copy = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Copy Pix"),
    )!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("rafa@pqp.gg");
  });

  it("renders Pix text as text: markup in it stays inert", async () => {
    // Not a value the validators accept, but the card must be safe on its own.
    const el = await mount(
      <VipUnlockCard support={{ kind: "support", pix: '<img src=x onerror="alert(1)">' }} />,
    );
    await act(async () =>
      el.querySelector<HTMLButtonElement>("[data-home-support-cta]")!.click(),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("[data-home-support-pix-text]")?.textContent).toBe(
      '<img src=x onerror="alert(1)">',
    );
  });
});
