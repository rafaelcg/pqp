// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "@pqp/shared";

/**
 * The Emoji section follows Manage Emoji, the bit the server enforces on every
 * emoji write: owner and Manage Emoji see it, Manage Server alone does not.
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

function mount(
  role: "owner" | "admin" | "member",
  { canManageServer = false, canManageEmoji = false } = {},
) {
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
          canManageEmoji={canManageEmoji}
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
    mount("owner");
    expect(emojiTab()).not.toBeNull();
  });

  it("is there for somebody with Manage Emoji", () => {
    mount("admin", { canManageServer: true, canManageEmoji: true });
    expect(emojiTab()).not.toBeNull();
  });

  it("is there for a cargo that holds only Manage Emoji", () => {
    mount("member", { canManageEmoji: true });
    expect(emojiTab()).not.toBeNull();
  });

  it("is not there with Manage Server alone", () => {
    mount("admin", { canManageServer: true });
    expect(emojiTab()).toBeNull();
  });

  it("is not there for a plain member", () => {
    mount("member");
    expect(emojiTab()).toBeNull();
  });

  it("opens to the upload control and the counter", async () => {
    mount("owner");
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
