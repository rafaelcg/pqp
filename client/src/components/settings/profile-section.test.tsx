// @vitest-environment jsdom
import { act } from "react";
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
  }: { handleError?: string | null; handle?: string } = {},
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
            displayName={user?.displayName ?? ""}
            onDisplayName={() => {}}
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
    const alert = row("public-link").querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Esse link já tem dono. Tenta outro.");
    // The kit's error line carries its icon.
    expect(alert?.querySelector("svg")).not.toBeNull();
  });

  it("is not invalid without a handle error", async () => {
    await mount(USER);
    expect(linkField().getAttribute("aria-invalid")).toBeNull();
    expect(row("public-link").querySelector('[role="alert"]')).toBeNull();
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
    expect(row("public-link").querySelectorAll('[role="alert"]')).toHaveLength(1);
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
