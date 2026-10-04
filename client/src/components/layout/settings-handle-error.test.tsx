// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * The seam between the shell and Perfil for a taken public link: the shell
 * recognises the handle claim's 409 and hands Perfil a localized sentence
 * through `useSettingsShell().profileHandleError`, so the tab can draw it
 * under the link field. Perfil is replaced by a probe that reads the seam.
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

const updateMe = vi.hoisted(() => vi.fn());
const fetchMe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  updateMe,
  fetchMe,
}));

vi.mock("@/components/settings/profile-section", async () => {
  const { useSettingsShell } = await import("@/components/settings/kit");
  return {
    ProfileSection: ({
      displayName,
      onDisplayName,
      handle,
      onHandle,
    }: {
      displayName: string;
      onDisplayName: (next: string) => void;
      handle: string;
      onHandle: (next: string) => void;
    }) => {
      const { profileHandleError } = useSettingsShell();
      return (
        <div>
          <input
            data-name=""
            value={displayName}
            onChange={(event) => onDisplayName(event.target.value)}
          />
          <input
            data-handle=""
            value={handle}
            onChange={(event) => onHandle(event.target.value)}
          />
          <p data-handle-error="">{profileHandleError ?? ""}</p>
        </div>
      );
    },
  };
});

const { SettingsModal, defaultLocalSettings } = await import("./settings-modal");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { ApiError } = await import("@/lib/api");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  updateMe.mockReset();
  fetchMe.mockReset();
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

function mount(onUserUpdated: (user: User) => void = () => {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TooltipProvider>
        <SettingsModal
          open
          user={USER}
          localSettings={defaultLocalSettings}
          blockedUsers={[]}
          onClose={() => {}}
          onLocalSave={() => {}}
          onUserUpdated={onUserUpdated}
          onUnblockUser={() => {}}
          requestedSection="profile"
        />
      </TooltipProvider>,
    );
  });
}

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

const field = (name: string) =>
  document.querySelector<HTMLInputElement>(`[data-${name}]`)!;
const handleError = () => document.querySelector("[data-handle-error]")!.textContent;
const bar = () => document.querySelector("[data-unsaved-bar]");

async function save() {
  await act(async () => {
    bar()!.querySelector<HTMLButtonElement>("[data-unsaved-save]")!.click();
    await Promise.resolve();
  });
}

describe("a taken public link", () => {
  it("reaches Perfil localized, and clears when the link is edited", async () => {
    updateMe.mockRejectedValueOnce(new ApiError(409, "That handle is already taken"));
    mount();
    type(field("name"), "Rafael");
    await save();

    expect(handleError()).toMatch(/Esse link já tem dono|already someone's/);
    expect(bar()!.textContent).not.toContain("That handle is already taken");

    type(field("handle"), "rafa2");
    expect(handleError()).toBe("");
  });

  it("says a username out of numbers in the reader's language, in the bar", async () => {
    updateMe.mockRejectedValueOnce(
      new ApiError(409, "That username has no numbers left. Please pick a different one."),
    );
    mount();
    type(field("name"), "Rafael");
    await save();

    expect(handleError()).toBe("");
    const alert = bar()!.querySelector('[role="alert"]')?.textContent ?? "";
    // Our own sentence for this refusal, never the server's.
    expect(alert).toMatch(/Pick another one|Escolha outro/);
    expect(alert).not.toContain("Please pick a different one");
  });

  it("refuses a link the server would refuse before asking to confirm it", async () => {
    updateMe.mockClear();
    mount();
    type(field("handle"), "a");
    await save();

    expect(updateMe).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    expect(handleError()).toMatch(/3 a 20|3 to 20/);
  });

  it("says a reserved link is reserved, not that it breaks the format", async () => {
    updateMe.mockClear();
    mount();
    type(field("handle"), "admin");
    await save();

    expect(updateMe).not.toHaveBeenCalled();
    expect(handleError()).toMatch(/reserved|reservado/i);
    expect(handleError()).not.toMatch(/3 a 20|3 to 20/);
  });

  it("reads the account back when the link was claimed but another field failed", async () => {
    updateMe.mockRejectedValueOnce(
      new ApiError(409, "That username has no numbers left. Please pick a different one."),
    );
    fetchMe.mockResolvedValueOnce({ ...USER, handle: "rafa2" });
    const onUserUpdated = vi.fn();
    mount(onUserUpdated);
    type(field("handle"), "rafa2");
    await save();
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] button, [role="alertdialog"] button',
      ),
    ].find((button) => button.textContent?.includes("@rafa2"))!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ handle: "rafa2" }));
  });

  it("says the request limiter's 429 in the bar, without blaming the new link", async () => {
    updateMe.mockRejectedValueOnce(new ApiError(429, "Slow down"));
    fetchMe.mockResolvedValueOnce(USER);
    mount();
    type(field("handle"), "rafa2");
    await save();
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] button, [role="alertdialog"] button',
      ),
    ].find((button) => button.textContent?.includes("@rafa2"))!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(handleError()).toBe("");
    expect(bar()!.querySelector('[role="alert"]')?.textContent).toMatch(
      /Wait a moment|Espera um pouco|Espere um pouco/,
    );
  });

  it("does not blame an unchanged link for another field's 400", async () => {
    updateMe.mockClear();
    updateMe.mockRejectedValueOnce(new ApiError(400, "Invalid request"));
    mount();
    type(field("name"), "Rafael");
    await save();

    expect(handleError()).toBe("");
    const alert = bar()!.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).not.toMatch(/3 a 20|3 to 20/);
  });
});
