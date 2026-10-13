// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { messageSchema } from "@pqp/shared";
import type { ChatMessage } from "@/hooks/use-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageList, type MessageAuthorInfo } from "./message-list";

/**
 * An author who is no longer in the server (left, kicked, banned, or a
 * deleted bot) gets a quiet "saiu" tag, but only when the roster is known to
 * be whole: an empty map while it loads must not mark everybody as gone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const HOOK = "44444444-4444-4444-8444-444444444444";

function message(n: number, authorId: string, authorName: string, extra: object = {}): ChatMessage {
  return messageSchema.parse({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    channelId: CHANNEL,
    authorId,
    authorName,
    authorTag: null,
    authorAvatarUrl: null,
    body: `mensagem ${n}`,
    createdAt: `2026-10-12T08:0${n}:00.000Z`,
    ...extra,
  });
}

const MESSAGES = [
  message(1, ME, "Rafa"),
  message(2, GONE, "Bia"),
  message(3, HOOK, "CI", { isWebhook: true }),
];

const ROSTER = new Map<string, MessageAuthorInfo>([[ME, { username: "rafa" }]]);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(authorsComplete: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <MessageList
          messages={MESSAGES}
          currentUserId={ME}
          channelId={CHANNEL}
          onToggleReaction={() => {}}
          authors={ROSTER}
          authorsComplete={authorsComplete}
        />
      </TooltipProvider>,
    );
  });
  return host;
}

function goneTags(container: HTMLElement): string[] {
  return [...container.querySelectorAll("span[title]")]
    .filter((el) => /não está mais no servidor|no longer in this server/.test(el.getAttribute("title") ?? ""))
    .map((el) => el.getAttribute("title") ?? "");
}

describe("an author who left", () => {
  it("is tagged once the roster is whole, and nobody else is", () => {
    const tags = goneTags(mount(true));
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain("Bia");
  });

  it("is not tagged while the roster is unknown", () => {
    expect(goneTags(mount(false))).toEqual([]);
  });
});
