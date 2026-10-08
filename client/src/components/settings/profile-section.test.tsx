// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * Perfil on its own, for the states the running app cannot reach under the
 * dev bypass (no user: the account loads before Settings can open) and for
 * the field's accessible wiring (the taken link and the cooldown date are
 * read with the link field, not only with the row).
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchPublicProfile: vi.fn(),
  fetchAvatarConfig: vi.fn(() => Promise.resolve({ enabled: false })),
  fetchUserBannerConfig: vi.fn(() =>
    Promise.resolve({ enabled: false, maxBytes: 1, width: 1500, height: 500 }),
  ),
}));

const { ProfileSection } = await import("./profile-section");
const { SettingsShellContext } = await import("@/components/settings/kit");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ApiError, fetchPublicProfile } = await import("@/lib/api");
const { localizedUploadFailure } = await import("@/components/user/avatar-picker");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const USER = {
  id: "00000000-0000-0000-0000-000000000001",
  clerkId: "clerk_1",
  displayName: "Rafa",
  username: "rafa",
  discriminator: "0001",
  tag: "rafa#0001",
  avatarUrl: null,
  handle: "rafa",
  handleChangedAt: null,
  dmPrivacy: "server_members",
  bannerUrl: null,
  customStatus: null,
  isInstanceModerator: false,
} as unknown as User;

async function mount(
  user: User | null,
  {
    handleError = null,
    handle = user?.handle ?? "",
    displayName = user?.displayName ?? "",
    nameError = null,
    spies = {},
  }: {
    handleError?: string | null;
    handle?: string;
    displayName?: string;
    nameError?: string | null;
    spies?: { onDisplayName?: (next: string) => void };
  } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <SettingsShellContext.Provider
          value={{
            profileDirty: false,
            openSection: () => {},
            headerActionsSlot: null,
            profileHandleError: handleError,
          }}
        >
          <ProfileSection
            user={user}
            displayName={displayName}
            displayNameError={nameError}
            onDisplayName={spies.onDisplayName ?? (() => {})}
            username={user?.username ?? ""}
            onUsername={() => {}}
            handle={handle}
            onHandle={() => {}}
            avatarUrl=""
            onAvatarUrl={() => {}}
            onUserUpdated={() => {}}
          />
        </SettingsShellContext.Provider>
      </TooltipProvider>,
    );
    await Promise.resolve();
  });
}

const row = (id: string) => host!.querySelector(`[data-settings-row="${id}"]`)!;
const linkField = () =>
  row("public-link").querySelector<HTMLInputElement>("input")!;
const buttons = () =>
  Array.from(host!.querySelectorAll("button")).map(
    (b) => b.textContent?.trim() || b.getAttribute("aria-label") || "",
  );
function describedBy(input: HTMLElement): string {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");
}

describe("Perfil", () => {
  it("renders with no user: an empty preview identifier, no tag readout, no link actions", async () => {
    await mount(null);

    // The preview draws a name line and, with an identifier, a mono line.
    // With no account and no drafts there is no identifier to draw.
    expect(host!.querySelector("p.font-mono")).toBeNull();
    // The tag readout and its copy button live in the username row.
    expect(row("username").querySelectorAll("button")).toHaveLength(0);
    expect(row("username").querySelector(".font-mono")).toBeNull();
    // Copy link and Open act on a saved link; there is none.
    expect(row("public-link").querySelector("a")).toBeNull();
    expect(row("public-link").querySelectorAll("button")).toHaveLength(0);
    // The field itself is open: no account means no cooldown.
    expect(linkField().disabled).toBe(false);
    expect(buttons().join(" ")).not.toMatch(/Cop(y|iar) link/);
  });

  it("shows the saved link's actions and the tag readout for an account", async () => {
    await mount(USER);
    expect(row("public-link").querySelector("a")?.getAttribute("href")).toContain("@rafa");
    expect(row("username").textContent).toContain("rafa#0001");
    expect(row("username").querySelectorAll("button")).toHaveLength(1);
  });

  it("draws a taken link under the field and ties it to the field", async () => {
    await mount(USER, { handleError: "Esse link já tem dono. Tenta outro." });
    const input = linkField();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(input)).toContain("Esse link já tem dono. Tenta outro.");
    // Plain text the field describes itself with: the unsaved bar is what
    // says the refusal, so the line under the field is not a second alert.
    expect(row("public-link").querySelector('[role="alert"]')).toBeNull();
    const line = [...row("public-link").querySelectorAll("p")].find((node) =>
      node.textContent?.includes("Esse link já tem dono. Tenta outro."),
    );
    // The kit's error line carries its icon.
    expect(line?.querySelector("svg")).not.toBeNull();
  });

  it("is not invalid without a handle error", async () => {
    await mount(USER);
    expect(linkField().getAttribute("aria-invalid")).toBeNull();
    expect(row("public-link").querySelector('[role="alert"]')).toBeNull();
  });

  it("marks a reserved link invalid, as it does a taken one", async () => {
    await mount(USER, { handle: "admin" });
    expect(linkField().getAttribute("aria-invalid")).toBe("true");
  });

  it("reads the cooldown date with the disabled field", async () => {
    await mount({ ...USER, handleChangedAt: new Date().toISOString() } as User);
    const input = linkField();
    expect(input.disabled).toBe(true);
    const description = describedBy(input);
    expect(description).toMatch(/\d{4}/);
    expect(description).toBe(
      row("public-link").querySelector("p")?.textContent,
    );
  });
});

describe("Perfil: the public link while it is typed", () => {
  const check = vi.mocked(fetchPublicProfile);
  const status = () =>
    row("public-link").querySelector<HTMLElement>("[data-handle-availability]")!;
  /** Lets the 350 ms debounce run and the answer land. */
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    check.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the rule under the field and stays silent for the link you already own", async () => {
    await mount(USER);
    expect(row("public-link").textContent).toContain("3 to 20 letters, numbers, _ . or -");
    expect(describedBy(linkField())).toContain("3 to 20 letters");
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(status().textContent).toBe("");
  });

  it("says Verificando, then Disponível when the public page does not exist", async () => {
    check.mockResolvedValue(null);
    await mount(USER, { handle: "novo_nome" });
    expect(status().textContent).toBe("Checking…");
    expect(check).not.toHaveBeenCalled();
    await settle();
    expect(check).toHaveBeenCalledWith("novo_nome", expect.anything());
    expect(status().textContent).toBe("Available");
    expect(status().getAttribute("role")).toBe("status");
    expect(linkField().getAttribute("aria-invalid")).toBeNull();
  });

  it("says the link has an owner when the public page exists", async () => {
    check.mockResolvedValue({} as never);
    await mount(USER, { handle: "alguem" });
    await settle();
    expect(status().textContent).toBe("That link is already someone's");
    expect(linkField().getAttribute("aria-invalid")).toBe("true");
  });

  it("never calls a reserved link free, and does not ask the server", async () => {
    await mount(USER, { handle: "admin" });
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(status().textContent).toBe("That one is reserved.");
  });

  it("stays silent when the check fails: a 429 or a dropped network is not free", async () => {
    check.mockRejectedValue(new ApiError(429, "slow down"));
    await mount(USER, { handle: "novo_nome" });
    await settle();
    expect(status().textContent).toBe("");
  });

  it("stays silent for a link too short to be one, and while the rename is locked", async () => {
    await mount(USER, { handle: "ab" });
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(status().textContent).toBe("");

    act(() => root?.unmount());
    host?.remove();
    await mount({ ...USER, handleChangedAt: new Date().toISOString() } as User, {
      handle: "outro_nome",
    });
    await settle();
    expect(check).not.toHaveBeenCalled();
    expect(row("public-link").querySelector("[data-handle-availability]")).toBeNull();
  });

  it("lets the save's own refusal speak instead of repeating it", async () => {
    check.mockResolvedValue({} as never);
    await mount(USER, { handle: "alguem", handleError: "Esse link já tem dono. Tenta outro." });
    await settle();
    expect(status().textContent).toBe("");
    // Said once, by the unsaved bar: neither the availability line nor the
    // error under the field speaks it again.
    expect(row("public-link").querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(row("public-link").textContent).toContain("Esse link já tem dono. Tenta outro.");
  });
});

describe("Perfil: Nome de exibição", () => {
  const nameField = () => row("display-name").querySelector<HTMLInputElement>("input")!;
  const text = () => row("display-name").textContent ?? "";

  it("counts characters only near the limit", async () => {
    await mount(USER, { displayName: "x".repeat(23) });
    expect(text()).not.toMatch(/\/32/);
    act(() => root?.unmount());
    host?.remove();
    await mount(USER, { displayName: "x".repeat(29) });
    expect(text()).toContain("29/32");
    expect(describedBy(nameField())).toContain("29/32");
  });

  it("says an empty name as you leave the field, once, and not before", async () => {
    await mount(USER, { displayName: "" });
    expect(row("display-name").querySelector('[role="alert"]')).toBeNull();
    act(() => nameField().focus());
    act(() => nameField().blur());
    const alerts = row("display-name").querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("Enter a display name.");
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
  });

  it("draws the save's refusal in the same single place", async () => {
    await mount(USER, { displayName: "", nameError: "Enter a display name." });
    act(() => nameField().focus());
    act(() => nameField().blur());
    expect(row("display-name").querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  /** A parent that holds the name, the way the shell does. */
  async function mountStateful(initial: string) {
    function Parent() {
      const [name, setName] = useState(initial);
      return (
        <TooltipProvider>
          <SettingsShellContext.Provider
            value={{ profileDirty: false, openSection: () => {}, headerActionsSlot: null }}
          >
            <ProfileSection
              user={USER}
              displayName={name}
              onDisplayName={setName}
              username="rafa"
              onUsername={() => {}}
              handle="rafa"
              onHandle={() => {}}
              avatarUrl=""
              onAvatarUrl={() => {}}
              onUserUpdated={() => {}}
            />
          </SettingsShellContext.Provider>
        </TooltipProvider>
      );
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Parent />);
    });
  }

  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("collapses repeated spaces on leaving an edited name", async () => {
    await mountStateful("Ana");
    act(() => nameField().focus());
    type(nameField(), "Ana  QA   Dev");
    expect(nameField().value).toBe("Ana  QA   Dev");
    act(() => nameField().blur());
    expect(nameField().value).toBe("Ana QA Dev");
  });

  it("leaves an untouched name alone: clicking through must not stage an edit", async () => {
    await mountStateful("Ana  QA");
    act(() => nameField().focus());
    act(() => nameField().blur());
    expect(nameField().value).toBe("Ana  QA");
  });

  it("saves on Enter through the bar's own button, with the spaces already collapsed", async () => {
    vi.useFakeTimers();
    try {
      const save = document.createElement("button");
      save.setAttribute("data-unsaved-save", "");
      const clicked = vi.fn();
      save.addEventListener("click", clicked);
      document.body.append(save);
      await mountStateful("Ana");
      act(() => nameField().focus());
      type(nameField(), "Ana  QA");
      act(() => {
        nameField().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      expect(nameField().value).toBe("Ana QA");
      expect(clicked).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(clicked).toHaveBeenCalledTimes(1);

      // An IME word being confirmed is not a save.
      act(() => {
        nameField().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(clicked).toHaveBeenCalledTimes(1);
      save.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Perfil: Enter in the link and username fields", () => {
  it("saves through the bar's own button", async () => {
    vi.useFakeTimers();
    try {
      const save = document.createElement("button");
      save.setAttribute("data-unsaved-save", "");
      const clicked = vi.fn();
      save.addEventListener("click", clicked);
      document.body.append(save);
      await mount(USER);
      for (const id of ["public-link", "username"]) {
        const input = row(id).querySelector<HTMLInputElement>("input")!;
        act(() => {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5);
      });
      expect(clicked).toHaveBeenCalledTimes(2);
      save.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Perfil: Capa when uploads are off", () => {
  it("is one quiet line that says what works, with no Capa row and no live region", async () => {
    await mount(USER);
    expect(row("banner")).toBeNull();
    const note = Array.from(host!.querySelectorAll('[role="note"]')).find((el) =>
      /turned off/.test(el.textContent ?? ""),
    );
    expect(note?.textContent).toContain("use a link or one of the ready-made ones");
    expect(host!.textContent).not.toMatch(/unavailable/i);
  });
});

describe("localizedUploadFailure", () => {
  it("replaces the upload helpers' English sentences and keeps an API error", () => {
    const local = localizedUploadFailure(
      new Error("That file is not an image this browser can read."),
      "Não deu pra enviar essa foto. Tenta de novo.",
    );
    expect(local.message).toBe("Não deu pra enviar essa foto. Tenta de novo.");

    const api = new ApiError(503, "database_unavailable");
    expect(localizedUploadFailure(api, "fallback")).toBe(api);
  });
});
