// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { messageSchema } from "@pqp/shared";
import type { ChatMessage } from "@/hooks/use-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageList } from "./message-list";

/**
 * What the windowed transcript mounts, in a DOM with no layout.
 *
 * jsdom measures nothing, so every row is the default guess and the viewport
 * is the 800px fallback: enough to check the shape (a bounded run of rows,
 * spacers standing for the rest, the live end mounted, the whole thing when
 * the list is short or the flag is off). Scroll anchoring, jumps and focus
 * need real layout and are in `e2e/message-window.spec.ts`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, n) =>
    messageSchema.parse({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      channelId: CHANNEL,
      authorId: n % 2 === 0 ? ME : BOB,
      authorName: n % 2 === 0 ? "Rafa" : "bob",
      authorTag: null,
      authorAvatarUrl: null,
      body: `mensagem ${n}`,
      createdAt: new Date(Date.UTC(2026, 9, 12, 8, n)).toISOString(),
    }),
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(count: number, windowing: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <MessageList
          messages={messages(count)}
          currentUserId={ME}
          channelId={CHANNEL}
          onToggleReaction={() => {}}
          windowing={windowing}
        />
      </TooltipProvider>,
    );
  });
}

const articles = () => host!.querySelectorAll('[role="log"] article');
const labelled = (n: number) =>
  [...articles()].some((one) =>
    one.getAttribute("aria-label")?.includes(`mensagem ${n}`),
  );

describe("windowed transcript shape", () => {
  it("mounts a bounded run of a long transcript, the live end among it, with a spacer for the rest", () => {
    mount(600, true);
    expect(articles().length).toBeGreaterThan(10);
    expect(articles().length).toBeLessThan(120);
    // Opens on the tail: the newest row is mounted, the oldest is not.
    expect(labelled(599)).toBe(true);
    expect(labelled(0)).toBe(false);
    const gap = host!.querySelector<HTMLElement>("[data-message-window-gap]");
    expect(gap).not.toBeNull();
    expect(gap!.getAttribute("aria-hidden")).toBe("true");
    expect(parseFloat(gap!.style.height)).toBeGreaterThan(1000);
  });

  it("gives every mounted row its place, in order, with the total left open", () => {
    mount(600, true);
    const positions = [...articles()].map((one) =>
      Number(one.getAttribute("aria-posinset")),
    );
    expect(positions.every((pos) => pos > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(
      [...articles()].every((one) => one.getAttribute("aria-setsize") === "-1"),
    ).toBe(true);
  });

  it("keeps the one row the keyboard is on mounted wherever it is", () => {
    mount(600, true);
    // The roving tab stop starts on the newest row, and is always mounted: a
    // list with no tab stop cannot be tabbed into.
    expect(
      [...articles()].filter((one) => one.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });

  it("renders a short transcript whole, with nothing standing in for rows", () => {
    mount(60, true);
    expect(articles()).toHaveLength(60);
    expect(host!.querySelector("[data-message-window-gap]")).toBeNull();
  });

  it("renders every row when the flag is off, with none of the window's elements", () => {
    mount(600, false);
    expect(articles()).toHaveLength(600);
    expect(host!.querySelector("[data-message-window]")).toBeNull();
    expect(host!.querySelector("[data-row-id]")).toBeNull();
    expect(
      [...articles()].every((one) => !one.hasAttribute("aria-posinset")),
    ).toBe(true);
    // Mounting 600 unwindowed rows took 6.7 s on a loaded CI runner, over the
    // 5 s default; the point of the test is the shape, not the speed.
  }, 30_000);
});
