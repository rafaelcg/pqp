// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "@pqp/shared";

/**
 * The Emoji section follows Manage Server, the bit the server enforces on every
 * emoji write: owner and Manage Server see it, a plain member does not.
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

const { ServerSettingsDialog } = await import("./server-settings-dialog");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/emoji")) {
        return new Response(
          JSON.stringify({ emoji: [], limit: 50, uploadEnabled: true, maxBytes: 262144, size: 128 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function mount(role: "owner" | "admin" | "member", canManageServer: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const server = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Sandbox",
    role,
  } as unknown as Server;
  act(() => {
    root!.render(
      <TooltipProvider>
        <ServerSettingsDialog
          open
          server={server}
          currentUserId="u1"
          canManageServer={canManageServer}
          onClose={() => {}}
          onRenamed={() => {}}
          onOwnershipTransferred={() => {}}
          onDeleted={() => {}}
        />
      </TooltipProvider>,
    );
  });
}

function emojiTab(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === "Emoji",
    ) ?? null
  );
}

describe("server settings: Emoji section", () => {
  it("is there for the owner", () => {
    mount("owner", true);
    expect(emojiTab()).not.toBeNull();
  });

  it("is there for somebody with Manage Server", () => {
    mount("admin", true);
    expect(emojiTab()).not.toBeNull();
  });

  it("is not there without Manage Server", () => {
    mount("admin", false);
    expect(emojiTab()).toBeNull();
  });

  it("opens to the upload control and the counter", async () => {
    mount("owner", true);
    await act(async () => {
      emojiTab()!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("[data-server-emoji]")).not.toBeNull();
    expect(document.querySelector("[data-emoji-count]")?.textContent).toBe("0 of 50");
  });
});
