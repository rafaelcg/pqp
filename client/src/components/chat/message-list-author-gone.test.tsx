// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageSchema } from "@pqp/shared";
import type { ChatMessage } from "@/hooks/use-chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useConfirmedGoneAuthors,
  type AuthorGoneCheck,
  type MissingAuthor,
} from "@/hooks/use-confirmed-gone-authors";
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
  vi.useRealTimers();
});

function mount(
  authorsComplete: boolean,
  check: AuthorGoneCheck | null = { confirmed: new Set([GONE]), report: () => {} },
) {
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
          authorGoneCheck={check ?? undefined}
        />
      </TooltipProvider>,
    );
  });
  return host;
}

function goneTags(container: HTMLElement): string[] {
  return [...container.querySelectorAll("span.sr-only")]
    .map((el) => el.textContent ?? "")
    .filter((text) => /não está mais no servidor|no longer in this server/.test(text));
}

describe("an author who left", () => {
  it("is tagged once a fresh read still lacks them, and nobody else is", () => {
    const tags = goneTags(mount(true));
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain("Bia");
  });

  it("says why in text a keyboard or screen reader reaches, not only in title", () => {
    const tag = [...mount(true).querySelectorAll("span.sr-only")].find((el) =>
      /Bia/.test(el.textContent ?? ""),
    );
    expect(tag).toBeTruthy();
    expect(tag?.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is not tagged while the roster is unknown", () => {
    expect(goneTags(mount(false))).toEqual([]);
  });

  it("is not tagged before the confirming read, and is reported for one", () => {
    const reported: MissingAuthor[][] = [];
    const check: AuthorGoneCheck = {
      confirmed: new Set(),
      report: (missing) => reported.push([...missing]),
    };
    expect(goneTags(mount(true, check))).toEqual([]);
    expect(reported).toEqual([[{ authorId: GONE, messageId: MESSAGES[1]!.id }]]);
  });

  it("is never tagged without a check to confirm it", () => {
    expect(goneTags(mount(true, null))).toEqual([]);
  });
});

/**
 * The same list with the real check behind it: what the member roster read
 * says is what decides the tag.
 */
describe("an author who left, checked by a roster read", () => {
  type Refresh = () => Promise<ReadonlySet<string> | null>;

  function Live({
    refresh,
    messages,
  }: {
    refresh: Refresh;
    messages: ChatMessage[];
  }) {
    const check = useConfirmedGoneAuthors("s1", refresh, ROSTER);
    return (
      <TooltipProvider>
        <MessageList
          messages={messages}
          currentUserId={ME}
          channelId={CHANNEL}
          onToggleReaction={() => {}}
          authors={ROSTER}
          authorsComplete
          authorGoneCheck={check}
        />
      </TooltipProvider>
    );
  }

  function mountLive(refresh: Refresh, messages: ChatMessage[] = MESSAGES) {
    // jsdom has no element scrollTo, which a list that grows calls.
    Element.prototype.scrollTo = () => {};
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Live refresh={refresh} messages={messages} />));
    return host;
  }

  function deferredRead() {
    let resolve!: (members: ReadonlySet<string> | null) => void;
    const promise = new Promise<ReadonlySet<string> | null>((r) => (resolve = r));
    return { promise, resolve };
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("is tagged after a failed read once the retry reads the roster", async () => {
    vi.useFakeTimers();
    const results: Array<ReadonlySet<string> | null> = [null, new Set([ME])];
    let calls = 0;
    const container = mountLive(async () => results[calls++]!);
    await advance(0);
    expect(calls).toBe(1);
    expect(goneTags(container)).toEqual([]);
    await advance(5_000);
    expect(calls).toBe(2);
    const tags = goneTags(container);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain("Bia");
  });

  it("is not tagged when the read holds them, even before the roster on screen does", async () => {
    let calls = 0;
    const container = mountLive(async () => (calls++, new Set([ME, GONE])));
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toBe(1);
    expect(goneTags(container)).toEqual([]);
  });

  it("loses the tag while a new message from them is checked", async () => {
    const reads = [deferredRead(), deferredRead()];
    let calls = 0;
    const container = mountLive(() => reads[calls++]!.promise);
    await act(async () => {
      reads[0]!.resolve(new Set([ME]));
    });
    expect(goneTags(container)).toHaveLength(1);

    // They rejoined and wrote before the roster on screen caught up.
    act(() =>
      root!.render(
        <Live
          refresh={() => reads[calls++]!.promise}
          messages={[...MESSAGES, message(4, GONE, "Bia")]}
        />,
      ),
    );
    expect(calls).toBe(2);
    expect(goneTags(container)).toEqual([]);
    await act(async () => {
      reads[1]!.resolve(new Set([ME]));
    });
    // Both of their messages carry it again.
    expect(goneTags(container)).toHaveLength(2);
  });
});
