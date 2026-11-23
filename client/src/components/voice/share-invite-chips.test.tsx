// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShareInviteChips, shareInviteSlots } from "./share-invite-chips";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("shareInviteSlots", () => {
  it("names up to the limit and keeps the rest for the menu", () => {
    expect(shareInviteSlots(["a", "b", "c", "d"], 2)).toEqual({ shown: ["a", "b"], rest: ["c", "d"] });
  });

  it("names one past the limit instead of saying +1", () => {
    expect(shareInviteSlots(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b", "c"], rest: [] });
  });
});

describe("ShareInviteChips", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("draws nothing with no invites", () => {
    act(() => root.render(<ShareInviteChips invites={[]} onWatch={() => {}} />));
    expect(container.querySelector("[data-testid='share-invite-chips']")).toBeNull();
  });

  it("watches the share whose button was pressed", () => {
    const onWatch = vi.fn();
    act(() =>
      root.render(
        <ShareInviteChips
          invites={[
            { peerId: "p2", presenterName: "Ana" },
            { peerId: "p3", presenterName: "Bia" },
          ]}
          onWatch={onWatch}
        />,
      ),
    );
    const chip = container.querySelector("[data-share-invite='p3']");
    expect(chip).not.toBeNull();
    act(() => chip!.querySelector("button")!.click());
    expect(onWatch).toHaveBeenCalledWith("p3");
  });

  it("offers every share past the chips in a menu that watches it", async () => {
    const onWatch = vi.fn();
    act(() =>
      root.render(
        <TooltipProvider>
          <ShareInviteChips
            invites={[
              { peerId: "p2", presenterName: "Ana" },
              { peerId: "p3", presenterName: "Bia" },
              { peerId: "p4", presenterName: "Caio" },
              { peerId: "p5", presenterName: "Duda" },
            ]}
            onWatch={onWatch}
          />
        </TooltipProvider>,
      ),
    );
    expect(container.querySelectorAll("[data-share-invite]")).toHaveLength(2);
    const more = container.querySelector<HTMLButtonElement>("[data-testid='share-invite-more']")!;
    expect(more.textContent).toContain("2");
    await act(async () => {
      more.focus();
      more.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    const row = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) =>
      el.textContent?.includes("Duda"),
    );
    expect(row).toBeDefined();
    await act(async () => {
      row!.click();
    });
    expect(onWatch).toHaveBeenCalledWith("p5");
  });
});
