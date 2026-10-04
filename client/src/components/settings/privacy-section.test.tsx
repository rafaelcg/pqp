// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockedUser, User } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import {
  listSettingsRows,
  resetSettingsRowsForTest,
} from "@/components/settings/kit/registry";
import { SettingsSectionContext } from "@/components/settings/kit/sections";
import { PrivacySection } from "@/components/settings/privacy-section";

const updateMe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateMe,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const user = { id: "me", dmPrivacy: "server_members" } as unknown as User;

const blocked: BlockedUser[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    displayName: "Fulano",
    username: "fulano",
    tag: "fulano#0001",
    avatarUrl: null,
    blockedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as BlockedUser,
  {
    id: "00000000-0000-4000-8000-000000000002",
    displayName: "Beltrana",
    username: "beltrana",
    tag: "beltrana#0002",
    avatarUrl: null,
    blockedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as BlockedUser,
];

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SettingsSectionContext.Provider value="privacy">
        <PrivacySection
          user={user}
          blockedUsers={blocked}
          onUserUpdated={() => undefined}
          onUnblockUser={() => undefined}
        />
      </SettingsSectionContext.Provider>,
    ),
  );
}

function radios(): HTMLButtonElement[] {
  return [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

beforeEach(() => {
  updateMe.mockReset();
  resetSettingsRowsForTest();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("PrivacySection", () => {
  it("keeps blocked people out of the settings registry", () => {
    mount();
    expect(host!.querySelectorAll("[data-settings-row^='blocked-']")).toHaveLength(2);
    expect(listSettingsRows("privacy")).toEqual([]);
  });

  it("names each unblock button after the person", () => {
    mount();
    const names = [...host!.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label"))
      .filter(Boolean);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toContain("Fulano");
    expect(names[1]).toContain("Beltrana");
  });

  it("draws the save status under the option that was picked", async () => {
    let finish!: (value: User) => void;
    updateMe.mockReturnValue(new Promise<User>((resolve) => (finish = resolve)));
    mount();
    await act(async () => {
      radios()[2]!.click();
      await Promise.resolve();
    });
    const status = host!.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    // The picked option is checked while its write runs, and the status is a
    // sibling of that radio, inside the same option, not a band of its own.
    expect(radios()[2]!.getAttribute("aria-checked")).toBe("true");
    expect(status!.closest("[role='radiogroup']")).not.toBeNull();
    expect(radios()[2]!.parentElement!.contains(status)).toBe(true);
    await act(async () => {
      finish({ ...user, dmPrivacy: "nobody" } as User);
      await Promise.resolve();
    });
  });

  it("ignores the arrow keys while a write is in flight", async () => {
    let finish!: (value: User) => void;
    updateMe.mockReturnValue(new Promise<User>((resolve) => (finish = resolve)));
    mount();
    await act(async () => {
      radios()[0]!.click();
      await Promise.resolve();
    });
    expect(updateMe).toHaveBeenCalledTimes(1);

    // The picked option holds the check (and focus) while the write runs.
    const checked = radios()[0]!;
    expect(checked.getAttribute("aria-checked")).toBe("true");
    checked.focus();
    act(() => {
      checked.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    // Focus stays on the picked option and nothing else is written.
    expect(document.activeElement).toBe(checked);
    expect(updateMe).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ ...user, dmPrivacy: "everyone" } as User);
      await Promise.resolve();
    });
  });

  it("goes back to the stored option and says so in words when the write fails", async () => {
    updateMe.mockRejectedValue(new ApiError(503, "database_unavailable"));
    mount();
    await act(async () => {
      radios()[2]!.click();
      await Promise.resolve();
    });
    const alert = host!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).not.toContain("database_unavailable");
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    expect(radios()[1]!.parentElement!.contains(alert)).toBe(true);
  });
});
