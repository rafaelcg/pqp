// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * The profile save model (spec section C) from the outside: the drafts are
 * seeded once per open and survive a new `user` arriving while the dialog is
 * up, the unsaved bar shows while they differ, and a close attempt with
 * staged edits is refused rather than losing them.
 *
 * The rerender with a NEW user object is the case that matters. An avatar or
 * banner upload, or a DM privacy change, hands one down mid-edit, and the old
 * seeding effect ran on `[open, user]`, so it silently reset the name being
 * typed.
 */

// Sign out renders nothing under the bypass rather than reaching for Clerk.
vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

// Only the profile save is replaced; everything else in the module is real.
const updateMe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateMe,
}));

// Which save chord applies (Cmd on Apple, Ctrl elsewhere) is read per open.
const apple = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/composer-formatting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composer-formatting")>()),
  isApplePlatform: () => apple.value,
}));

const { SettingsModal, defaultLocalSettings } = await import("./settings-modal");
// The app mounts one `TooltipProvider` at its root; Settings tabs may use
// `Tooltip`, which throws without one.
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ApiError } = await import("@/lib/api");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    clerkId: "clerk_1",
    displayName: "Rafa",
    username: "rafa",
    discriminator: "0001",
    tag: "rafa#0001",
    avatarUrl: null,
    handle: null,
    handleChangedAt: null,
    dmPrivacy: "server_members",
    bannerUrl: null,
    customStatus: null,
    isInstanceModerator: false,
    ...overrides,
  } as unknown as User;
}

function render(user: User, onClose = () => {}) {
  act(() => {
    root!.render(
      <TooltipProvider>
        <SettingsModal
          open
          user={user}
          localSettings={defaultLocalSettings}
          blockedUsers={[]}
          onClose={onClose}
          onLocalSave={() => {}}
          onUserUpdated={() => {}}
          onUnblockUser={() => {}}
          requestedSection="profile"
        />
      </TooltipProvider>,
    );
  });
}

function mount(user: User, onClose?: () => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render(user, onClose);
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function displayNameInput(): HTMLInputElement {
  const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(
    (node) => node.maxLength > 0 && node.value !== undefined && !node.placeholder,
  );
  if (!input) throw new Error("no display name input");
  return input;
}

/** React only sees a typed value through the native setter plus an event. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function bar(): HTMLElement | null {
  return document.querySelector("[data-unsaved-bar]");
}

describe("Settings profile drafts", () => {
  it("shows no bar until something is staged", () => {
    mount(makeUser());
    expect(displayNameInput().value).toBe("Rafa");
    expect(bar()).toBeNull();
  });

  it("keeps a dirty draft when a new user arrives while open", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    expect(bar()).not.toBeNull();

    // What a banner upload does: the same account, a new object.
    render(makeUser({ bannerUrl: "/api/users/1/banner" } as Partial<User>));

    expect(displayNameInput().value).toBe("Rafael");
    expect(bar()).not.toBeNull();
  });

  it("marks Perfil in the rail while an edit is staged", () => {
    mount(makeUser());
    const dot = () =>
      document.querySelector("#settings-tab-profile [data-rail-dirty]");
    expect(dot()).toBeNull();
    type(displayNameInput(), "Rafael");
    expect(dot()).not.toBeNull();
  });

  it("puts the account's value back on Descartar", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    const discard = [...bar()!.querySelectorAll("button")].find(
      (button) => !button.hasAttribute("data-unsaved-save"),
    )!;
    act(() => discard.click());
    expect(displayNameInput().value).toBe("Rafa");
    expect(bar()).toBeNull();
  });

  it("refuses to close with staged edits, and closes once they are gone", () => {
    const onClose = vi.fn();
    mount(makeUser(), onClose);
    type(displayNameInput(), "Rafael");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(bar()?.textContent).toMatch(/descarte|discard/i);

    type(displayNameInput(), "Rafa");
    expect(bar()).toBeNull();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not read a missing handle as an edit", () => {
    mount(makeUser({ handle: null, avatarUrl: null }));
    expect(bar()).toBeNull();
  });

  it("says a taken link in the reader's language, never the server's sentence", async () => {
    updateMe.mockRejectedValueOnce(new ApiError(409, "That handle is already taken"));
    mount(makeUser({ handle: "rafa" }));
    type(displayNameInput(), "Rafael");
    const save = bar()!.querySelector<HTMLButtonElement>("[data-unsaved-save]")!;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(updateMe).toHaveBeenCalledTimes(1);
    const alert = bar()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Esse link já tem dono|already someone's/);
    expect(bar()!.textContent).not.toContain("That handle is already taken");
  });

  it("saves with Ctrl+S, and with Cmd+S on Apple", async () => {
    updateMe.mockReset();
    updateMe.mockImplementation(async () => makeUser({ displayName: "Rafael" }));
    for (const onApple of [false, true]) {
      apple.value = onApple;
      mount(makeUser());
      type(displayNameInput(), "Rafael");
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "s",
            ctrlKey: !onApple,
            metaKey: onApple,
            bubbles: true,
          }),
        );
        await Promise.resolve();
      });
      expect(updateMe).toHaveBeenCalledTimes(onApple ? 2 : 1);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
    apple.value = false;
  });

  it("asks before claiming a link: Keep sends nothing, the confirm sends once", async () => {
    updateMe.mockReset();
    updateMe.mockImplementation(async () => makeUser({ handle: "rafa" }));
    mount(makeUser({ handle: null }));
    const handleInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="yourname"], input[placeholder="seunome"]',
    )!;
    type(handleInput, "rafa");
    const save = () =>
      bar()!.querySelector<HTMLButtonElement>("[data-unsaved-save]")!;
    const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
    const confirmButton = (name: RegExp) =>
      [...dialogs().at(-1)!.querySelectorAll("button")].find((b) =>
        name.test(b.textContent ?? ""),
      )!;

    act(() => save().click());
    expect(dialogs().at(-1)!.textContent).toMatch(/pqp\.gg\/@rafa/);
    act(() => confirmButton(/^(Keep|Manter)$/).click());
    expect(updateMe).not.toHaveBeenCalled();
    expect(handleInput.value).toBe("rafa");

    act(() => save().click());
    await act(async () => {
      confirmButton(/^(Claim link|Pegar link)$/).click();
      await Promise.resolve();
    });
    expect(updateMe).toHaveBeenCalledTimes(1);
    expect(updateMe.mock.calls[0]![0]).toMatchObject({ handle: "rafa" });
  });

  it("follows a profile change from another device in fields not edited here", () => {
    mount(makeUser());
    expect(bar()).toBeNull();
    // Renamed on the phone while this dialog sat open and untouched.
    render(makeUser({ displayName: "Rafa do celular" }));
    expect(displayNameInput().value).toBe("Rafa do celular");
    expect(bar()).toBeNull();
  });

  it("puts focus back inside the dialog after Descartar removes the bar", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    const discard = [...bar()!.querySelectorAll("button")].find(
      (button) => !button.hasAttribute("data-unsaved-save"),
    )!;
    act(() => discard.focus());
    act(() => discard.click());
    expect(bar()).toBeNull();
    const panel = document.querySelector('[role="dialog"]')!;
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});
