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

const { SettingsModal, defaultLocalSettings, DISCARD_UNDO_MS } = await import("./settings-modal");
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

function barButton(kind: "save" | "discard" | "continue" | "undo"): HTMLButtonElement | null {
  return bar()?.querySelector<HTMLButtonElement>(`[data-unsaved-${kind}]`) ?? null;
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function dangerEdge(): boolean {
  return Boolean(bar()?.parentElement?.className.includes("border-danger"));
}

describe("Settings profile drafts", () => {
  it("shows no bar until something is staged", () => {
    mount(makeUser());
    expect(displayNameInput().value).toBe("Rafa");
    expect(bar()).toBeNull();
  });

  it("says the bar's line through a region that was mounted before the bar", () => {
    mount(makeUser());
    const regions = () =>
      [...document.querySelectorAll<HTMLElement>('p.sr-only[role="status"]')];
    const before = regions().find((node) => node.textContent === "");
    expect(before).toBeDefined();
    type(displayNameInput(), "Rafael");
    expect(before!.isConnected).toBe(true);
    expect(before!.textContent).toMatch(/unsaved|não salvas|sin guardar/i);
    // The bar's visible line is plain text, so it is not said twice.
    expect(bar()!.querySelector('[role="status"]')).toBeNull();
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

  it("puts the account's value back on Descartar, and offers Desfazer for a moment", () => {
    vi.useFakeTimers();
    try {
      mount(makeUser());
      type(displayNameInput(), "Rafael");
      act(() => barButton("discard")!.click());
      expect(displayNameInput().value).toBe("Rafa");
      expect(bar()?.textContent).toMatch(/Changes discarded|Alterações descartadas/);
      expect(barButton("save")).toBeNull();

      act(() => vi.advanceTimersByTime(DISCARD_UNDO_MS));
      expect(bar()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings the discarded edits back on Desfazer, with focus on Descartar", () => {
    vi.useFakeTimers();
    try {
      mount(makeUser());
      type(displayNameInput(), "Rafael");
      act(() => barButton("discard")!.click());
      expect(displayNameInput().value).toBe("Rafa");
      const undo = barButton("undo")!;
      act(() => undo.focus());
      act(() => undo.click());
      act(() => vi.advanceTimersByTime(0));
      expect(displayNameInput().value).toBe("Rafael");
      expect(barButton("save")).not.toBeNull();
      expect(document.activeElement).toBe(barButton("discard"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the undo offer once something new is typed", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    act(() => barButton("discard")!.click());
    type(displayNameInput(), "Rafa!");
    expect(barButton("undo")).toBeNull();
    expect(barButton("save")).not.toBeNull();
  });

  it("refuses to close with staged edits, and closes once they are gone", () => {
    const onClose = vi.fn();
    mount(makeUser(), onClose);
    type(displayNameInput(), "Rafael");

    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(bar()?.textContent).toMatch(/Save or discard\?|Salvar ou descartar\?/);
    expect(dangerEdge()).toBe(true);

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
    const alert = bar()!.querySelector("[data-unsaved-error]");
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

  it("reads clean after a save, and keeps an edit typed while the save was out", async () => {
    updateMe.mockReset();
    let land!: (user: User) => void;
    updateMe.mockReturnValueOnce(new Promise<User>((resolve) => (land = resolve)));
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    await act(async () => {
      barButton("save")!.click();
      await Promise.resolve();
    });
    // Typed while the request is out: newer than the response.
    type(displayNameInput(), "Rafael Gugli");
    const saved = makeUser({ displayName: "Rafael" });
    await act(async () => {
      land(saved);
      await Promise.resolve();
    });
    render(saved);
    expect(displayNameInput().value).toBe("Rafael Gugli");
    expect(bar()).not.toBeNull();

    // A save with nothing typed meanwhile leaves nothing staged: the bar
    // only flashes "Salvo".
    updateMe.mockResolvedValueOnce(makeUser({ displayName: "Rafael Gugli" }));
    await act(async () => {
      barButton("save")!.click();
      await Promise.resolve();
    });
    render(makeUser({ displayName: "Rafael Gugli" }));
    expect(displayNameInput().value).toBe("Rafael Gugli");
    expect(barButton("save")).toBeNull();
    expect(bar()?.textContent).toMatch(/Saved|Salvo/);
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
    act(() => confirmButton(/^(Go back|Voltar)$/).click());
    expect(updateMe).not.toHaveBeenCalled();
    expect(handleInput.value).toBe("rafa");

    act(() => save().click());
    await act(async () => {
      confirmButton(/^(Claim @rafa|Pegar @rafa)$/).click();
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

  it("keeps focus inside the dialog after Descartar and after the undo offer ends", () => {
    vi.useFakeTimers();
    try {
      mount(makeUser());
      type(displayNameInput(), "Rafael");
      const discard = barButton("discard")!;
      act(() => discard.focus());
      act(() => discard.click());
      // On Desfazer while it is offered, so the keyboard can take it back.
      expect(document.activeElement).toBe(barButton("undo"));
      act(() => vi.advanceTimersByTime(DISCARD_UNDO_MS));
      expect(bar()).toBeNull();
      const panel = document.querySelector('[role="dialog"]')!;
      expect(panel.contains(document.activeElement)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers Continuar editando on a refused close and focuses it, not Salvar", () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      mount(makeUser(), onClose);
      type(displayNameInput(), "Rafael");
      pressEscape();
      act(() => vi.advanceTimersByTime(0));
      expect(document.activeElement).toBe(barButton("continue"));

      act(() => barButton("continue")!.click());
      act(() => vi.advanceTimersByTime(0));
      expect(dangerEdge()).toBe(false);
      expect(barButton("continue")).toBeNull();
      expect(bar()?.textContent).toMatch(/unsaved changes|alterações não salvas/);
      expect(document.activeElement?.tagName).toBe("INPUT");
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the danger edge as soon as the person edits again", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    pressEscape();
    expect(dangerEdge()).toBe(true);
    type(displayNameInput(), "Rafaela");
    expect(dangerEdge()).toBe(false);
    expect(barButton("continue")).toBeNull();
  });

  it("says why a refused close moved the person to Perfil from another tab", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    act(() => document.querySelector<HTMLButtonElement>("#settings-tab-notifications")!.click());
    pressEscape();
    expect(
      document.querySelector("#settings-tab-profile")!.getAttribute("aria-selected"),
    ).toBe("true");
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toMatch(/brought you back to Profile|Voltamos pro Perfil/);

    // Refused from Perfil itself: nothing moved, so nothing to explain.
    type(displayNameInput(), "Rafaela");
    pressEscape();
    expect(panel.textContent).not.toMatch(/brought you back to Profile|Voltamos pro Perfil/);
  });

  it("asks the browser before a reload drops staged edits, and only then", () => {
    mount(makeUser());
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    type(displayNameInput(), "Rafael");
    expect(unload()).toBe(true);
    type(displayNameInput(), "Rafa");
    expect(unload()).toBe(false);
  });
});

describe("Settings profile save, QA round 3", () => {
  const usernameInput = () =>
    document.querySelector<HTMLInputElement>('[data-settings-row="username"] input')!;
  const panel = () => document.getElementById("settings-panel")!;
  const barRegion = () =>
    [...document.querySelectorAll<HTMLElement>('p.sr-only[role="status"]')].find(
      (node) => !node.hasAttribute("data-settings-announcer"),
    )!;
  const buttonNamed = (name: RegExp) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      name.test(b.textContent?.trim() ?? ""),
    )!;

  it("keeps focus on Salvar while the save runs and after it fails, and says both", async () => {
    updateMe.mockReset();
    let fail!: (error: unknown) => void;
    updateMe.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    const save = barButton("save")!;
    act(() => save.focus());
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(barButton("discard")!.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    expect(barRegion().textContent).toMatch(/Saving|Salvando/);
    // Descartar is ignored while the request is out.
    act(() => barButton("discard")!.click());
    expect(displayNameInput().value).toBe("Rafael");

    await act(async () => {
      fail(new Error("offline"));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(barButton("save"));
    const error = bar()!.querySelector("[data-unsaved-error]")!.textContent;
    expect(error).toBeTruthy();
    expect(barRegion().textContent).toBe(error);
  });

  it("brings a blank name into view and focuses it, from Perfil or from another tab", () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      updateMe.mockReset();
      mount(makeUser());
      type(displayNameInput(), "");
      act(() => barButton("save")!.focus());
      act(() => barButton("save")!.click());
      act(() => vi.advanceTimersByTime(0));
      expect(updateMe).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(displayNameInput());
      expect(scroll).toHaveBeenCalled();

      // Ctrl+S from another tab lands on the field too.
      act(() => document.querySelector<HTMLButtonElement>("#settings-tab-notifications")!.click());
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
        );
      });
      act(() => vi.advanceTimersByTime(0));
      expect(document.activeElement).toBe(displayNameInput());
    } finally {
      vi.useRealTimers();
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("refuses a name with a right-to-left override, under the field", () => {
    updateMe.mockReset();
    mount(makeUser());
    type(displayNameInput(), "Rafa‮gpj.exe");
    const row = document.querySelector('[data-settings-row="display-name"]')!;
    expect(row.textContent).toMatch(/invisible character|caractere invisível/);
    act(() => barButton("save")!.click());
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("keeps Salvo up for the whole moment after a second save", async () => {
    vi.useFakeTimers();
    try {
      updateMe.mockReset();
      updateMe.mockImplementation(async (patch: { displayName?: string }) =>
        makeUser({ displayName: patch.displayName ?? "Rafa" }),
      );
      mount(makeUser());
      type(displayNameInput(), "Rafael");
      await act(async () => {
        barButton("save")!.click();
        await Promise.resolve();
      });
      render(makeUser({ displayName: "Rafael" }));
      expect(bar()?.textContent).toMatch(/Saved|Salvo/);

      act(() => vi.advanceTimersByTime(1000));
      type(displayNameInput(), "Rafaela");
      await act(async () => {
        barButton("save")!.click();
        await Promise.resolve();
      });
      render(makeUser({ displayName: "Rafaela" }));
      // 1.6s after the first save, 0.6s after the second.
      act(() => vi.advanceTimersByTime(600));
      expect(bar()?.textContent).toMatch(/Saved|Salvo/);
      act(() => vi.advanceTimersByTime(1000));
      expect(bar()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an avatar link that is not https, and names the length limit", () => {
    updateMe.mockReset();
    mount(makeUser());
    act(() => buttonNamed(/^(Use a link|Usar um link)$/).click());
    const link = () =>
      document.querySelector<HTMLInputElement>('[data-settings-row="avatar"] input:not([type=file])')!;
    for (const value of ["http://example.com/a.png", "//example.com/a.png", "/api/x.png"]) {
      type(link(), value);
      // What was typed stays in the field, a leading "/" included.
      expect(link().value).toBe(value);
      act(() => barButton("save")!.click());
      expect(bar()!.querySelector("[data-unsaved-error]")?.textContent).toMatch(/https:\/\//);
    }
    type(link(), `https://example.com/${"a".repeat(500)}.png`);
    act(() => barButton("save")!.click());
    expect(bar()!.querySelector("[data-unsaved-error]")?.textContent).toMatch(/500/);
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("still saves a rename for an account whose saved avatar is http", async () => {
    updateMe.mockReset();
    updateMe.mockResolvedValue(makeUser({ displayName: "Rafael" }));
    mount(makeUser({ avatarUrl: "http://old.example/a.png" }));
    type(displayNameInput(), "Rafael");
    await act(async () => {
      barButton("save")!.click();
      await Promise.resolve();
    });
    expect(updateMe).toHaveBeenCalledTimes(1);
  });

  it("lands on Perfil's panel after Ver no Perfil, not on the page", () => {
    mount(makeUser());
    type(displayNameInput(), "Rafael");
    act(() => document.querySelector<HTMLButtonElement>("#settings-tab-notifications")!.click());
    const show = buttonNamed(/^(Show in Profile|Ver no Perfil)$/);
    act(() => show.focus());
    act(() => show.click());
    expect(
      document.querySelector("#settings-tab-profile")!.getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.activeElement).toBe(panel());
  });

  it("transliterates the username and explains an emptied one", () => {
    mount(makeUser());
    type(usernameInput(), "João Silva");
    expect(usernameInput().value).toBe("joao_silva");
    type(usernameInput(), "");
    const row = document.querySelector('[data-settings-row="username"]')!;
    expect(row.textContent).toMatch(/can't be empty.*rafa|não pode ficar vazio.*rafa/);
    expect(bar()).toBeNull();
  });

  it("raises buttons and selects to a 44px target on a phone, from one rule", () => {
    mount(makeUser());
    const wrapper = document.getElementById("settings-panel")!.closest(".sm\\:flex-row")!;
    expect(wrapper.className).toContain("max-sm:[&_button:not([role])]:min-h-11");
    expect(wrapper.className).toContain("max-sm:[&_select]:min-h-11");
  });

  it("pads the pane by the bar's real height when its buttons wrap", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const height = this.hasAttribute("data-unsaved-bar-frame") ? 170 : 0;
        return { height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
      });
    try {
      mount(makeUser());
      type(displayNameInput(), "Rafael");
      const content = panel().firstElementChild as HTMLElement;
      expect(content.style.paddingBottom).toBe("186px");
      expect(panel().style.scrollPaddingBottom).toBe("186px");
    } finally {
      rect.mockRestore();
    }
  });
});
