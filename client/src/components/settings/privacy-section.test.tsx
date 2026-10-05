// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockedUser, PublicUser, User } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import {
  listSettingsRows,
  resetSettingsRowsForTest,
} from "@/components/settings/kit/registry";
import { SettingsSectionContext } from "@/components/settings/kit/sections";
import { PrivacySection } from "@/components/settings/privacy-section";

const updateMe = vi.hoisted(() => vi.fn());
const lookupUserByTag = vi.hoisted(() => vi.fn());
const lookupUserByHandle = vi.hoisted(() => vi.fn());
const blockUser = vi.hoisted(() => vi.fn());
const unblockUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateMe,
  lookupUserByTag,
  lookupUserByHandle,
  blockUser,
  unblockUser,
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

type Props = Partial<React.ComponentProps<typeof PrivacySection>>;

function render(props: Props = {}) {
  root!.render(
    <SettingsSectionContext.Provider value="privacy">
      <PrivacySection
        user={user}
        blockedUsers={blocked}
        onUserUpdated={() => undefined}
        onUnblockUser={() => undefined}
        {...props}
      />
    </SettingsSectionContext.Provider>,
  );
}

function mount(props: Props = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => render(props));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...host!.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const stranger = {
  id: "00000000-0000-4000-8000-000000000009",
  displayName: "Trolinho",
  username: "trolinho",
  tag: "trolinho#7781",
  avatarUrl: null,
} as unknown as PublicUser;

function radios(): HTMLButtonElement[] {
  return [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

beforeEach(() => {
  updateMe.mockReset();
  lookupUserByTag.mockReset();
  lookupUserByHandle.mockReset();
  blockUser.mockReset();
  unblockUser.mockReset();
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

  it("says the save status beside the group title, not inside the options", async () => {
    let finish!: (value: User) => void;
    updateMe.mockReturnValue(new Promise<User>((resolve) => (finish = resolve)));
    mount();
    // The live region exists before anything is saved, so the page below the
    // title never moves when the text arrives.
    const heading = host!.querySelector("h4")!;
    const region = heading.parentElement!.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region!.textContent).toBe("");

    await act(async () => {
      radios()[2]!.click();
      await Promise.resolve();
    });
    expect(region!.textContent).toContain("Saving");
    expect(region!.closest("[role='radiogroup']")).toBeNull();
    expect(host!.querySelector("[role='radiogroup'] [role='status']")).toBeNull();
    // The picked option is checked while its write runs.
    expect(radios()[2]!.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      finish({ ...user, dmPrivacy: "nobody" } as User);
      await Promise.resolve();
    });
    expect(region!.textContent).toContain("Saved");
  });

  it("moves focus with the arrow keys without writing anything", () => {
    mount();
    const checked = radios()[1]!;
    checked.focus();
    act(() => {
      checked.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(radios()[2]);
    act(() => {
      radios()[2]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(radios()[1]);
    expect(updateMe).not.toHaveBeenCalled();
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
  });

  it("picks the focused option with Space or Enter, once", async () => {
    updateMe.mockResolvedValue({ ...user, dmPrivacy: "nobody" } as User);
    mount();
    radios()[1]!.focus();
    act(() => {
      radios()[1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    await act(async () => {
      radios()[2]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(updateMe).toHaveBeenCalledWith({ dmPrivacy: "nobody" });
  });

  it("states the scope of each option, friends included", () => {
    mount();
    const text = host!.textContent ?? "";
    expect(text).toContain("Friends and people who share a community with me");
    expect(text).toContain("block the person");
    expect(text).toContain("Blocking ends the friendship");
  });

  it("says where to block somebody when the list is empty", () => {
    mount({ blockedUsers: [] });
    expect(host!.textContent).toContain("Nobody blocked.");
    expect(host!.textContent).toContain("More > Block");
  });

  it("blocks somebody by name#0000 and lists them", async () => {
    lookupUserByTag.mockResolvedValue({ user: stranger });
    blockUser.mockResolvedValue({ ok: true });
    mount();
    act(() => buttonByText("Block someone").click());
    const input = host!.querySelector<HTMLInputElement>("form input")!;
    expect(document.activeElement).toBe(input);
    type(input, "Trolinho#7781");
    await act(async () => {
      buttonByText("Block").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lookupUserByTag).toHaveBeenCalledWith("trolinho#7781");
    expect(blockUser).toHaveBeenCalledWith(stranger.id);
    expect(host!.querySelector("form")).toBeNull();
    expect(host!.textContent).toContain("Trolinho");
    // Back on the button, so the keyboard is not dropped on the page.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.activeElement).toBe(buttonByText("Block someone"));
  });

  it("looks a bare @handle up as a handle and hands the block to the app when it can", async () => {
    lookupUserByHandle.mockResolvedValue({ user: stranger });
    const onBlockUser = vi.fn().mockResolvedValue(undefined);
    mount({ onBlockUser });
    act(() => buttonByText("Block someone").click());
    type(host!.querySelector<HTMLInputElement>("form input")!, "@trolinho");
    await act(async () => {
      buttonByText("Block").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lookupUserByHandle).toHaveBeenCalledWith("trolinho");
    expect(onBlockUser).toHaveBeenCalledWith(stranger.id);
    expect(blockUser).not.toHaveBeenCalled();
  });

  it("keeps the form open and says why when nobody matches", async () => {
    lookupUserByTag.mockRejectedValue(new ApiError(404, "not_found"));
    mount();
    act(() => buttonByText("Block someone").click());
    type(host!.querySelector<HTMLInputElement>("form input")!, "ghost#0000");
    await act(async () => {
      buttonByText("Block").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host!.querySelector('form [role="alert"]')!.textContent).toContain(
      "No one found",
    );
    expect(blockUser).not.toHaveBeenCalled();
  });

  it("refuses to block yourself or somebody already blocked", async () => {
    lookupUserByTag.mockResolvedValueOnce({ user: { ...stranger, id: "me" } });
    mount();
    act(() => buttonByText("Block someone").click());
    const input = () => host!.querySelector<HTMLInputElement>("form input")!;
    type(input(), "me#0001");
    await act(async () => {
      buttonByText("Block").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host!.querySelector('form [role="alert"]')!.textContent).toContain(
      "yours",
    );
    lookupUserByTag.mockResolvedValueOnce({ user: blocked[0] });
    type(input(), "fulano#0001");
    await act(async () => {
      buttonByText("Block").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host!.querySelector('form [role="alert"]')!.textContent).toContain(
      "already",
    );
    expect(blockUser).not.toHaveBeenCalled();
  });

  it("cancels the form without blocking anyone", () => {
    mount();
    act(() => buttonByText("Block someone").click());
    type(host!.querySelector<HTMLInputElement>("form input")!, "abc");
    act(() => buttonByText("Cancel").click());
    expect(host!.querySelector("form")).toBeNull();
    expect(lookupUserByTag).not.toHaveBeenCalled();
    expect(lookupUserByHandle).not.toHaveBeenCalled();
  });

  it("tells you who was unblocked once their row is gone", async () => {
    const onUnblockUser = vi.fn().mockResolvedValue(undefined);
    mount({ onUnblockUser });
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>('button[aria-label="Unblock Fulano"]')!
        .click();
      await Promise.resolve();
    });
    expect(onUnblockUser).toHaveBeenCalledWith(blocked[0]!.id);
    // The app has not refreshed its list yet: still no notice.
    expect(host!.textContent).not.toContain("Fulano unblocked");
    act(() => render({ onUnblockUser, blockedUsers: [blocked[1]!] }));
    expect(host!.querySelector("[role='status']:not(:empty)")).not.toBeNull();
    expect(host!.textContent).toContain("Fulano unblocked");
  });

  it("keeps focus on Unblock while it runs and after it fails", async () => {
    let fail!: (error: unknown) => void;
    const onUnblockUser = vi.fn(
      () => new Promise<void>((_, reject) => (fail = reject)),
    );
    mount({ onUnblockUser });
    const button = host!.querySelector<HTMLButtonElement>(
      'button[aria-label="Unblock Fulano"]',
    )!;
    button.focus();
    await act(async () => button.click());
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(onUnblockUser).toHaveBeenCalledTimes(1);
    await act(async () => {
      fail(new ApiError(503, "x"));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(button);
  });

  it("keeps focus in the name field while the lookup runs", async () => {
    let answer!: (value: unknown) => void;
    lookupUserByTag.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mount();
    act(() => buttonByText("Block someone").click());
    const input = host!.querySelector<HTMLInputElement>("form input")!;
    type(input, "trolinho#7781");
    input.focus();
    await act(async () => {
      input.form!.requestSubmit();
    });
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    await act(async () => {
      answer({ user: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(input);
  });

  it("says nothing was unblocked when the request fails", async () => {
    const onUnblockUser = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "Upstream unavailable"));
    mount({ onUnblockUser });
    await act(async () => {
      host!
        .querySelector<HTMLButtonElement>('button[aria-label="Unblock Fulano"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host!.textContent).not.toContain("unblocked");
    const alert = host!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).not.toContain("Upstream unavailable");
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

  it("unblocks a row added from this tab with its own request, and only says so once it landed", async () => {
    lookupUserByTag.mockResolvedValue({ user: stranger });
    blockUser.mockResolvedValue({ ok: true });
    const onUnblockUser = vi.fn();
    mount({ onUnblockUser });
    act(() => buttonByText("Block someone").click());
    type(host!.querySelector<HTMLInputElement>("form input")!, "trolinho#7781");
    await act(async () => {
      buttonByText("Block").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const unblockButton = () =>
      host!.querySelector<HTMLButtonElement>('button[aria-label="Unblock Trolinho"]')!;

    // A failed request keeps the row, says why, and announces nothing.
    unblockUser.mockRejectedValueOnce(new ApiError(503, "Upstream unavailable"));
    await act(async () => {
      unblockButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unblockButton()).not.toBeNull();
    const alert = host!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).not.toContain("Upstream unavailable");
    expect(host!.textContent).not.toContain("unblocked");

    unblockUser.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      unblockButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unblockUser).toHaveBeenCalledWith(stranger.id);
    expect(onUnblockUser).not.toHaveBeenCalled();
    expect(host!.textContent).toContain("Trolinho unblocked");
  });
});
