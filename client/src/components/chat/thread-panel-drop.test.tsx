// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * A thread's panel is its own drop zone, and it follows the same rule as the
 * channel it hangs off: a reader who cannot send there is refused on the
 * overlay instead of being let stage uploads that could never be sent.
 */

vi.mock("@/lib/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments")>();
  return {
    ...actual,
    loadAttachmentConfig: () =>
      Promise.resolve({ enabled: true, maxBytes: 10 * 1024 * 1024 }),
  };
});

import { ThreadPanel } from "./thread-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const controller = new Proxy(
  {},
  {
    get: (_t, name) => {
      if (name === "getMessages" || name === "getTypingUsers") return () => [];
      if (name === "getSlowModeHeldUntil") return () => 0;
      if (String(name).startsWith("has") || String(name).startsWith("isL")) {
        return () => false;
      }
      return () => {};
    },
  },
) as never;

const thread = {
  channelId: "22222222-2222-4222-8222-222222222222",
  parentChannelId: "11111111-1111-4111-8111-111111111111",
  name: "a thread",
  rootMessageId: null,
  archived: false,
} as unknown as ThreadSummary;

function panelFor(canSend: boolean) {
  return (
      <TooltipProvider>
        <ThreadPanel
          thread={thread}
          origin={null}
          controller={controller}
          currentUser={null}
          serverId={null}
          parentChannelName="general"
          canModerate={false}
          canSend={canSend}
          blockedAuthorIds={new Set()}
          mentionCandidates={[]}
          isLoading={false}
          showLinkEmbeds={false}
          onClose={() => {}}
        />
      </TooltipProvider>
  );
}

async function mount(canSend: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(panelFor(canSend));
  });
  await act(async () => {});
  return host.querySelector("aside")!;
}

function dragEnter(target: Element) {
  const event = new Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: [], items: [], dropEffect: "none" },
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ThreadPanel drop zone", () => {
  it("accepts a file for a reader who can send", async () => {
    const panel = await mount(true);
    dragEnter(panel);
    const overlay = panel.querySelector("[data-file-drop-overlay]");
    expect(overlay?.getAttribute("data-file-drop-overlay")).toBe("accept");
    expect(overlay?.textContent).toBe("Drop to attach");
  });

  it("refuses, saying why, for a reader who cannot send", async () => {
    const panel = await mount(false);
    dragEnter(panel);
    const overlay = panel.querySelector("[data-file-drop-overlay]");
    expect(overlay?.getAttribute("data-file-drop-overlay")).toBe("refuse");
    expect(overlay?.textContent).toBe("You cannot send messages here");
  });
});

describe("ThreadPanel composer", () => {
  it("is a box for a reader who can send", async () => {
    const panel = await mount(true);
    expect(panel.querySelector("textarea")).not.toBeNull();
    expect(panel.querySelector("[data-composer-readonly]")).toBeNull();
  });

  it("is a read-only notice, with no usable box, for a reader who cannot send", async () => {
    const panel = await mount(false);
    const box = panel.querySelector("textarea");
    expect(box?.disabled).toBe(true);
    expect(box?.closest("[hidden]")).not.toBeNull();
    expect(panel.querySelector("[data-composer-readonly]")?.textContent).toBe(
      "You can read here, but you can't send messages.",
    );
  });

  it("keeps an unsent draft through a permission flip and gives it back", async () => {
    const panel = await mount(true);
    const box = panel.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(box, "meio da frase");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(box.value).toBe("meio da frase");

    await act(async () => {
      root!.render(panelFor(false));
    });
    // Same element, not a new one: unmounting would have dropped the text.
    expect(panel.querySelector("textarea")).toBe(box);
    expect(box.closest("[hidden]")).not.toBeNull();
    expect(box.value).toBe("meio da frase");

    await act(async () => {
      root!.render(panelFor(true));
    });
    expect(panel.querySelector("textarea")).toBe(box);
    expect(box.closest("[hidden]")).toBeNull();
    expect(box.disabled).toBe(false);
    expect(box.value).toBe("meio da frase");
  });
});
