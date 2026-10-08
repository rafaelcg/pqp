// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@pqp/shared";

/**
 * Perfil with uploads configured, for keyboard focus around the avatar and
 * banner writes: a busy button keeps focus (aria-disabled, never disabled),
 * and a Remover that takes itself away hands focus to the button beside it.
 * Its own file because both upload configs are memoised for the module.
 */

vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");

const api = vi.hoisted(() => ({
  fetchPublicProfile: vi.fn(() => Promise.resolve(null)),
  fetchAvatarConfig: vi.fn(() => Promise.resolve({ enabled: true })),
  fetchUserBannerConfig: vi.fn(() =>
    Promise.resolve({ enabled: true, maxBytes: 1, width: 1500, height: 500 }),
  ),
  deleteUserBanner: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));
const uploadAvatar = vi.hoisted(() => vi.fn());
vi.mock("@/lib/avatar-upload", () => ({ uploadAvatar }));
const uploadUserBanner = vi.hoisted(() => vi.fn());
vi.mock("@/lib/banner-upload", () => ({ uploadUserBanner }));

const { ProfileSection, handleFromInput, usernameFromInput } = await import(
  "./profile-section"
);
const { AVATAR_PRESETS } = await import("@/components/user/avatar-picker");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

function Harness({ initial }: { initial: User }) {
  const [user, setUser] = useState(initial);
  const [avatar, setAvatar] = useState(initial.avatarUrl ?? "");
  const [handle, setHandle] = useState(initial.handle ?? "");
  return (
    <TooltipProvider>
      <ProfileSection
        user={user}
        displayName={user.displayName}
        onDisplayName={() => {}}
        username={user.username ?? ""}
        onUsername={() => {}}
        handle={handle}
        onHandle={setHandle}
        avatarUrl={avatar}
        onAvatarUrl={setAvatar}
        onUserUpdated={setUser}
      />
    </TooltipProvider>
  );
}

async function mount(user: User) {
  await act(async () => {
    root!.render(<Harness initial={user} />);
    await Promise.resolve();
  });
  // The two config reads.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const row = (id: string) => host!.querySelector(`[data-settings-row="${id}"]`)!;
function buttonIn(id: string, name: RegExp): HTMLButtonElement {
  const found = [...row(id).querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    name.test(b.textContent?.trim() ?? ""),
  );
  if (!found) throw new Error(`no ${name} in ${id}`);
  return found;
}
function pick(input: HTMLInputElement) {
  const file = new File(["x"], "a.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
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

describe("Perfil uploads and focus", () => {
  it("keeps focus on the banner's Remover while it runs, then hands it to the upload button", async () => {
    let done!: (value: { user: User }) => void;
    api.deleteUserBanner.mockReturnValue(new Promise((resolve) => (done = resolve)));
    await mount({ ...USER, bannerUrl: "/api/users/1/banner" } as User);
    const remove = buttonIn("banner", /^(Remove|Remover)$/);
    act(() => remove.focus());
    await act(async () => remove.click());
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    const upload = buttonIn("banner", /^(Upload a banner|Replace|Enviar|Trocar)/);
    expect(upload.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(remove);
    // A second press while busy sends nothing.
    await act(async () => remove.click());
    expect(api.deleteUserBanner).toHaveBeenCalledTimes(1);

    await act(async () => {
      done({ user: { ...USER, bannerUrl: null } as User });
      await Promise.resolve();
    });
    expect(remove.isConnected).toBe(false);
    expect(document.activeElement).toBe(buttonIn("banner", /^(Upload a banner|Replace|Enviar|Trocar)/));
  });

  it("keeps focus on the banner and avatar upload buttons while they upload", async () => {
    uploadUserBanner.mockReturnValue(new Promise(() => {}));
    uploadAvatar.mockReturnValue(new Promise(() => {}));
    await mount(USER);
    for (const id of ["banner", "avatar"]) {
      const upload = buttonIn(id, /Upload|Enviar/);
      act(() => upload.focus());
      const input = row(id).querySelector<HTMLInputElement>('input[type="file"]')!;
      await act(async () => pick(input));
      expect(upload.disabled).toBe(false);
      expect(upload.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(upload);
    }
  });

  it("hands focus to the upload button when the avatar's Remover takes itself away", async () => {
    await mount({ ...USER, avatarUrl: AVATAR_PRESETS[0] } as User);
    const remove = buttonIn("avatar", /^(Remove|Remover)$/);
    act(() => remove.focus());
    act(() => remove.click());
    expect(remove.isConnected).toBe(false);
    expect(document.activeElement).toBe(buttonIn("avatar", /Upload|Enviar/));
  });

  it("refuses one more letter typed into a full link instead of dropping the last", async () => {
    await mount(USER);
    const field = row("public-link").querySelector<HTMLInputElement>("input")!;
    type(field, "abcdefghijklmnopqrst");
    expect(field.value).toBe("abcdefghijklmnopqrst");
    type(field, "abcdefghijXklmnopqrst");
    expect(field.value).toBe("abcdefghijklmnopqrst");
  });

  it("takes the handle out of a pasted profile address", async () => {
    await mount(USER);
    const field = row("public-link").querySelector<HTMLInputElement>("input")!;
    type(field, "https://pqp.gg/@Rafa_2/?ref=x");
    expect(field.value).toBe("rafa_2");
    // No `maxLength` on the field: the browser would cut the paste first.
    expect(field.hasAttribute("maxlength")).toBe(false);
  });

  it("says an emptied link stays, under the field and in its description", async () => {
    await mount(USER);
    const field = row("public-link").querySelector<HTMLInputElement>("input")!;
    type(field, "");
    const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");
    const said = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(said).toMatch(/pqp\.gg\/@rafa/);
    expect(said).toMatch(/can't be removed|Não dá pra apagar/);
  });
});

describe("handleFromInput", () => {
  it.each([
    ["https://pqp.gg/@rafa", "rafa"],
    ["pqp.gg/@rafa", "rafa"],
    ["https://pqp.gg/@rafa/", "rafa"],
    ["https://www.pqp.gg/@Rafa?utm=1#top", "rafa"],
    ["@rafa", "rafa"],
    ["pqp.gg", "pqp.gg"],
    ["João", "joao"],
    // Longer than the 20-character cap as typed, whole once the address is
    // taken off: the cap is applied to the handle, not to the paste.
    ["https://pqp.gg/@joaozinho", "joaozinho"],
    ["https://pqp.gg/@qa4_cfree?utm=1", "qa4_cfree"],
    ["a".repeat(30), "a".repeat(20)],
  ])("%s gives %s", (raw, expected) => {
    expect(handleFromInput(raw)).toBe(expected);
  });
});

describe("usernameFromInput", () => {
  it.each([
    ["João", "joao"],
    ["Ana Lú", "ana_lu"],
    ["çé_9!", "ce_9"],
  ])("%s gives %s", (raw, expected) => {
    expect(usernameFromInput(raw)).toBe(expected);
  });
});
