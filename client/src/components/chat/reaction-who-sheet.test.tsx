// @vitest-environment jsdom
import type { MessageReaction } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { ReactionWhoSheet } from "./reaction-who-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(reactions: MessageReaction[], onToggle = vi.fn(), onClose = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <I18nProvider>
        <ReactionWhoSheet
          reactions={reactions}
          initialEmoji="🔥"
          currentUserId={ME}
          avatarFor={() => null}
          onToggle={onToggle}
          onClose={onClose}
        />
      </I18nProvider>,
    ),
  );
  return { onToggle, onClose };
}

const sheet = () => document.querySelector("[data-reaction-who-sheet]");

describe("ReactionWhoSheet", () => {
  it("puts your row first and taking it off is one tap", () => {
    const { onToggle } = mount([
      { emoji: "🔥", count: 2, me: true, users: [{ id: BOB, displayName: "Bob" }, { id: ME, displayName: "Duda" }] },
      { emoji: "👍", count: 1, me: false, users: [{ id: BOB, displayName: "Bob" }] },
    ]);
    const rows = [...sheet()!.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("Duda");
    expect(rows[1]).toContain("Bob");
    act(() => {
      document.querySelector<HTMLElement>("[data-reaction-who-mine]")!.click();
    });
    expect(onToggle).toHaveBeenCalledWith("🔥");
  });

  it("switches emoji and only your own row is a button", () => {
    mount([
      { emoji: "🔥", count: 1, me: true, users: [{ id: ME, displayName: "Duda" }] },
      { emoji: "👍", count: 1, me: false, users: [{ id: BOB, displayName: "Bob" }] },
    ]);
    act(() => {
      sheet()!.querySelectorAll<HTMLElement>("[role=tab]")[1]!.click();
    });
    expect(sheet()!.querySelector("[role=tab][aria-selected=true]")!.textContent).toContain("👍");
    expect(document.querySelector("[data-reaction-who-mine]")).toBeNull();
  });

  it("says how many the capped list leaves out", () => {
    mount([{ emoji: "🔥", count: 7, me: false, users: [{ id: BOB, displayName: "Bob" }] }]);
    expect(sheet()!.textContent).toMatch(/6/);
    expect(sheet()!.querySelectorAll("li")).toHaveLength(2);
  });

  it("closes once the last reaction is gone", () => {
    mount([]);
    expect(sheet()).toBeNull();
  });
});
