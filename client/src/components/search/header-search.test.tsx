// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchServerMessages = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  searchServerMessages: (...args: unknown[]) => searchServerMessages(...args),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { HeaderSearch } from "./header-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  searchServerMessages.mockReset();
  searchServerMessages.mockResolvedValue({ results: [], hasMore: false });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const HIT = {
  messageId: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  channelName: "general",
  authorId: "00000000-0000-4000-8000-000000000003",
  authorName: "Ana",
  authorTag: null,
  authorAvatarUrl: null,
  snippet: "o gato",
  createdAt: "2026-10-15T12:00:00Z",
};

function member(id: string, displayName: string) {
  return { id, displayName, tag: null, role: "member" as const, avatarUrl: null };
}

async function openPanel(members: ReturnType<typeof member>[] = []): Promise<HTMLInputElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <TooltipProvider>
          <HeaderSearch
            serverId="server-1"
            serverName="Server"
            channel={{ id: "channel-1", name: "general" }}
            members={members}
            channels={[{ id: "channel-1", name: "general" }]}
            shortcutKey="k"
            shortcut="Ctrl K"
            tileClassName=""
          />
        </TooltipProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>("button[data-header-search]")!.click();
  });
  return document.querySelector<HTMLInputElement>("input[role=combobox]")!;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("HeaderSearch", () => {
  it("does not open a hit of the previous query while the new one loads", async () => {
    searchServerMessages.mockResolvedValueOnce({ results: [HIT], hasMore: false });
    searchServerMessages.mockReturnValueOnce(new Promise(() => {}));
    const input = await openPanel();
    await typeInto(input, "gato");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(document.getElementById(`header-search-${HIT.messageId}`)).not.toBeNull();
    await typeInto(input, "gatos pretos");
    await press(input, "Enter");
    // The panel is still open: Enter had nothing on screen to open.
    expect(document.querySelector("input[role=combobox]")).not.toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("picks the second filter suggestion with the arrow keys", async () => {
    const input = await openPanel([member("m1", "Ana"), member("m2", "Analu")]);
    await typeInto(input, "from:an");
    await press(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("header-search-suggestion-m2");
    await press(input, "Enter");
    expect(document.querySelector("[data-search-chip=de]")?.textContent).toContain("Analu");
  });

  it("searches once after the debounce and does not search again when the results land", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MemoryRouter>
          <TooltipProvider>
          <HeaderSearch
            serverId="server-1"
            serverName="Server"
            channel={{ id: "channel-1", name: "general" }}
            members={[]}
            channels={[{ id: "channel-1", name: "general" }]}
            shortcutKey="k"
            shortcut="Ctrl K"
            tileClassName=""
          />
          </TooltipProvider>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>("button[data-header-search]")!.click();
    });
    const input = document.querySelector<HTMLInputElement>("input[type=search], input[type=text], input:not([type])");
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "hello");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(searchServerMessages).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(searchServerMessages).toHaveBeenCalledTimes(1);
  });

  it("names the filters in plain words", async () => {
    await openPanel();
    const labels = [...document.querySelectorAll<HTMLButtonElement>("[data-header-search-popover] button")]
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(["From", "In", "Has image", "Has file", "Before", "Mentions"]));
    expect(labels.some((l) => l!.includes(":"))).toBe(false);
  });

  it("says the count once when the hits are in one channel", async () => {
    searchServerMessages.mockResolvedValueOnce({ results: [HIT, { ...HIT, messageId: `${HIT.messageId.slice(0, -1)}9` }], hasMore: false });
    const input = await openPanel();
    await typeInto(input, "gato");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(document.querySelector("[data-search-count]")?.textContent).toBe("2 results");
    expect(document.querySelector("[data-search-group]")).toBeNull();
  });

  it("keeps the count when an In chip hides the scope", async () => {
    searchServerMessages.mockResolvedValue({ results: [HIT], hasMore: false });
    const input = await openPanel();
    await typeInto(input, "in:general ");
    await typeInto(input, "gato");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(document.querySelector("[data-search-chip=em]")?.textContent).toContain("In #general");
    expect(document.querySelector("[role=radiogroup]")).toBeNull();
    expect(document.querySelector("[data-search-count]")?.textContent).toBe("1 result");
  });

  it("shows a person list in the results' place and closes it with Escape first", async () => {
    const input = await openPanel([member("m1", "Ana"), member("m2", "Bia")]);
    const fromButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "From",
    )!;
    await act(async () => {
      fromButton.click();
    });
    const suggestions = document.querySelector("[data-search-suggestions]");
    expect(suggestions?.closest("[role=listbox]")).not.toBeNull();
    // The filters and the scope stay where they were.
    expect(fromButton.isConnected).toBe(true);
    expect(document.querySelector("[role=radiogroup]")).not.toBeNull();
    await press(input, "Escape");
    expect(document.querySelector("[data-search-suggestions]")).toBeNull();
    expect(document.querySelector("input[role=combobox]")).not.toBeNull();
    await press(input, "Escape");
    expect(document.querySelector("input[role=combobox]")).toBeNull();
  });

  it("turns a typed from:<name> that names one person into that person's filter", async () => {
    const input = await openPanel([member("m1", "Dev"), member("m2", "Bia")]);
    await typeInto(input, "from:dev eae");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(document.querySelector("[data-search-chip=de]")?.textContent).toContain("From Dev");
    expect(input.value).toBe("eae");
    expect(searchServerMessages).toHaveBeenLastCalledWith(
      "server-1",
      { q: "eae", filters: { channelId: "channel-1", authorId: "m1" } },
      expect.anything(),
    );
  });
});
