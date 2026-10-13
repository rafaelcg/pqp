// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerRail } from "./server-rail";

/**
 * The rail's reorder surface that does not need layout: the keyboard, the
 * announcement, what stays fixed, and what the rail does when it is not given
 * a way to save. The pointer drag itself (hit testing, autoscroll, the drop
 * line) is measured in a real browser, because jsdom has no geometry.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function server(id: string, name: string): Server {
  return {
    id,
    name,
    ownerId: A,
    role: "member",
    createdAt: "2026-07-01T00:00:00.000Z",
    messageRetentionDays: null,
    ssoEmailDomain: null,
    iconUrl: null,
    bannerUrl: null,
    isCommunity: false,
    communityHomeEnabled: false,
    communityTagline: null,
    communityAbout: null,
    communityLinks: [],
    communitySlug: null,
    showOnProfile: true,
  };
}

const servers = [server(A, "Alfa"), server(B, "Beta"), server(C, "Gama")];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(onReorderServers?: (ids: string[]) => void, list: Server[] = servers) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <ServerRail
          servers={list}
          selectedServerId={null}
          serverUnread={{}}
          homeSelected={false}
          homeUnread={{ count: 0, mentions: 0 }}
          onSelectHome={() => {}}
          onSelectServer={() => {}}
          onCreateServer={() => {}}
          onJoinServer={() => {}}
          onInvite={() => {}}
          onOpenMembers={() => {}}
          onOpenSettings={() => {}}
          onLeaveServer={() => {}}
          onReorderServers={onReorderServers}
        />
      </TooltipProvider>,
    );
  });
  return host;
}

const tile = (name: string) =>
  host!.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

function key(target: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("the server rail, reordered from the keyboard", () => {
  it("Alt+ArrowDown moves the focused server one place and says where", () => {
    const save = vi.fn();
    mount(save);
    key(tile("Alfa"), { key: "ArrowDown", altKey: true });
    expect(save).toHaveBeenCalledWith([B, A, C]);
    expect(host!.querySelector("[role=status]")!.textContent).toContain("Alfa");
    expect(host!.querySelector("[role=status]")!.textContent).toContain("2");
  });

  it("Alt+ArrowUp, Alt+Home and Alt+End", () => {
    const save = vi.fn();
    mount(save);
    key(tile("Gama"), { key: "ArrowUp", altKey: true });
    expect(save).toHaveBeenLastCalledWith([A, C, B]);
    key(tile("Gama"), { key: "Home", altKey: true });
    expect(save).toHaveBeenLastCalledWith([C, A, B]);
    key(tile("Alfa"), { key: "End", altKey: true });
    expect(save).toHaveBeenLastCalledWith([B, C, A]);
  });

  it("does nothing at the ends, and for a plain arrow or Alt+Shift", () => {
    const save = vi.fn();
    mount(save);
    key(tile("Alfa"), { key: "ArrowUp", altKey: true });
    key(tile("Gama"), { key: "ArrowDown", altKey: true });
    key(tile("Beta"), { key: "ArrowDown" });
    key(tile("Beta"), { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("is not reorderable without a way to save", () => {
    mount();
    key(tile("Alfa"), { key: "ArrowDown", altKey: true });
    expect(host!.querySelector("[role=status]")).toBeNull();
    expect(host!.querySelector("[data-rail-item]")!.getAttribute("draggable")).toBeNull();
    expect(tile("Alfa").getAttribute("aria-describedby")).toBeNull();
  });

  it("describes the shortcut to a screen reader on every server", () => {
    mount(vi.fn());
    const describedBy = tile("Beta").getAttribute("aria-describedby")!;
    expect(host!.querySelector(`[id="${CSS.escape(describedBy)}"]`)!.textContent).toMatch(/Alt/);
    expect(tile("Beta").getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
  });

  it("only takes the Alt+arrow channel shortcut over while there is something to reorder", () => {
    mount(vi.fn());
    expect(host!.querySelector("[data-rail-reorderable]")).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    // One server: nothing to reorder, so Alt+Up / Down stay channel navigation.
    mount(vi.fn(), [servers[0]!]);
    expect(host!.querySelector("[data-rail-item]")).not.toBeNull();
    expect(host!.querySelector("[data-rail-reorderable]")).toBeNull();
  });

  it("keeps Chats and the add / discover buttons out of the list", () => {
    mount(vi.fn());
    const list = host!.querySelector("[data-rail-list]")!;
    expect(list.querySelectorAll("[data-rail-item]")).toHaveLength(3);
    // The door above and the create / join buttons below are siblings, not members.
    expect(list.querySelector("button svg.lucide-message-circle")).toBeNull();
    expect(list.querySelector("button svg.lucide-plus")).toBeNull();
    expect(list.querySelector("button svg.lucide-user-plus")).toBeNull();
  });
});
