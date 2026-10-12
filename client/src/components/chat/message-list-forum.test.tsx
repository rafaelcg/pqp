// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageSchema } from "@pqp/shared";
import type { ChatMessage } from "@/hooks/use-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageList } from "./message-list";

/**
 * Two things a forum post view leans on that the plain chat transcript did
 * not need, both found in the pre-launch QA pass:
 *
 * - "Marcar como solução" was reachable only from the right-click menu. The
 *   hover toolbar's "More" menu, which is where a mouse reader looks, did not
 *   have it, so on desktop the answer could only be picked by somebody who
 *   already knew to right-click.
 * - A post opens on the "Novas" line. When the first new reply was written
 *   by the same person as the message above the line, it was drawn as a
 *   continuation: no name, no avatar, right under the divider.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";

function message(n: number, authorId: string, authorName: string, createdAt: string): ChatMessage {
  // The schema fills every defaulted field, so the row sees a real message.
  return messageSchema.parse({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    channelId: CHANNEL,
    authorId,
    authorName,
    authorTag: null,
    authorAvatarUrl: null,
    body: `mensagem ${n}`,
    createdAt,
  });
}

// Opening message by me, then two replies by bob a minute apart (one group).
const MESSAGES = [
  message(1, ME, "Rafa", "2026-10-12T08:00:00.000Z"),
  message(2, BOB, "bob", "2026-10-12T08:10:00.000Z"),
  message(3, BOB, "bob", "2026-10-12T08:11:00.000Z"),
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: {
  unreadSince?: string | null;
  onToggleAnswer?: (id: string) => void;
  messages?: ChatMessage[];
  afterOpening?: ReactNode;
}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <MessageList
          messages={props.messages ?? MESSAGES}
          currentUserId={ME}
          channelId={CHANNEL}
          onToggleReaction={() => {}}
          unreadSince={props.unreadSince ?? null}
          forumPost={{
            authorId: ME,
            acceptedAnswerId: null,
            onToggleAnswer: props.onToggleAnswer,
            afterOpening: props.afterOpening,
          }}
        />
      </TooltipProvider>,
    );
  });
}

function rowOf(n: number): HTMLElement {
  const row = host!.querySelector<HTMLElement>(`[data-message-id="00000000-0000-4000-8000-00000000000${n}"]`)
    ?? [...host!.querySelectorAll<HTMLElement>("[data-group-start], [aria-label]")].find((one) =>
      one.getAttribute("aria-label")?.includes(`mensagem ${n}`),
    );
  if (!row) {
    throw new Error(`no row for message ${n}`);
  }
  return row;
}

describe("forum post transcript", () => {
  it("starts a new author block on the first unread reply", () => {
    // Read up to message 2: message 3 is the first unread, same author as 2.
    mount({ unreadSince: "2026-10-12T08:10:30.000Z" });
    expect(rowOf(2).hasAttribute("data-group-start")).toBe(true);
    expect(rowOf(3).hasAttribute("data-group-start")).toBe(true);
  });

  it("keeps a same-author run as one block when nothing is unread", () => {
    mount({ unreadSince: null });
    expect(rowOf(3).hasAttribute("data-group-start")).toBe(false);
  });

  it("offers Mark as solution in the hover More menu of a reply", () => {
    const onToggleAnswer = vi.fn();
    mount({ onToggleAnswer });
    const row = rowOf(3);
    const more = [...row.querySelectorAll("button")].find(
      (one) => one.getAttribute("aria-haspopup") === "menu",
    );
    expect(more).toBeTruthy();
    act(() => more!.click());
    const item = [...row.querySelectorAll('[role="menuitem"]')].find((one) =>
      one.textContent?.includes("Mark as solution"),
    ) as HTMLButtonElement | undefined;
    expect(item).toBeTruthy();
    act(() => item!.click());
    expect(onToggleAnswer).toHaveBeenCalledWith(MESSAGES[2]!.id);
  });

  it("gives the first reply its own header when something sits under the question", () => {
    // The OP answers themself a minute later: one block in a plain chat.
    const own = [
      message(1, ME, "Rafa", "2026-10-12T08:00:00.000Z"),
      message(2, ME, "Rafa", "2026-10-12T08:01:00.000Z"),
    ];
    mount({ messages: own });
    expect(rowOf(2).hasAttribute("data-group-start")).toBe(false);
    act(() => root?.unmount());
    host?.remove();

    mount({ messages: own, afterOpening: <div data-testid="replies">1 reply</div> });
    expect(host!.querySelector('[data-testid="replies"]')).not.toBeNull();
    expect(rowOf(2).hasAttribute("data-group-start")).toBe(true);
  });

  it("does not offer it on the opening message", () => {
    mount({ onToggleAnswer: vi.fn() });
    const row = rowOf(1);
    const more = [...row.querySelectorAll("button")].find(
      (one) => one.getAttribute("aria-haspopup") === "menu",
    );
    act(() => more!.click());
    expect(row.textContent).not.toContain("Mark as solution");
  });
});
