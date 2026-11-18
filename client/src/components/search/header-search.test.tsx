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

describe("HeaderSearch", () => {
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
});
