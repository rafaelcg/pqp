// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://pqp.gg/app" }
import type { CommunitySettings } from "@pqp/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The directory is asked at the moment the address goes on.
 *
 * What has to hold: ticking the address on a room that had none lights the
 * directory switch up in a box, still unticked, with the line that says what
 * listing means; the room is never listed unless the owner ticks it; an admin
 * never gets the offer; and a room whose address was already on shows no
 * offer at all (nothing just happened).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SETTINGS: CommunitySettings = {
  isCommunity: false,
  isListed: false,
  slug: null,
  tagline: null,
  about: null,
  links: [],
  featured: null,
  category: "geral",
  language: "pt",
  suspended: false,
};

const api = vi.hoisted(() => ({
  fetchCommunitySettings: vi.fn(),
  fetchServerImageConfig: vi.fn(async () => ({ enabled: false })),
  updateCommunitySettings: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  ...api,
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));

const { CommunitySettingsSection } = await import(
  "./community-settings-section"
);

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(canListPublicly: boolean) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <CommunitySettingsSection
        serverId="6f1c1d1e-0000-4000-8000-000000000001"
        serverName="Servidor de teste"
        canListPublicly={canListPublicly}
      />,
    );
  });
}

const checkbox = (label: RegExp) => {
  const found = [...document.querySelectorAll("label")].find((one) =>
    label.test(one.textContent ?? ""),
  );
  return found?.querySelector<HTMLInputElement>("input[type=checkbox]") ?? null;
};
const address = () => checkbox(/Turn on the public address/);
const directory = () => checkbox(/Show in the pqp directory/);
const offer = () => document.querySelector("[data-directory-offer]");

const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (one) => one.textContent === name,
  ) ?? null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function press(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
}

async function click(input: HTMLInputElement) {
  await act(async () => {
    input.click();
  });
}

beforeEach(() => {
  api.fetchCommunitySettings.mockReset();
  api.updateCommunitySettings.mockReset();
  api.fetchCommunitySettings.mockResolvedValue({ community: SETTINGS });
  api.updateCommunitySettings.mockImplementation(
    async (_id: string, body: Partial<CommunitySettings>) => ({
      ok: true,
      community: {
        ...SETTINGS,
        isCommunity: body.isCommunity ?? false,
        isListed: body.isListed ?? false,
        slug: "clube",
      },
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("CommunitySettingsSection: the directory offer", () => {
  it("offers the directory, unticked, the moment the owner turns the address on", async () => {
    await mount(true);
    expect(offer()).toBeNull();
    expect(directory()!.disabled).toBe(true);

    await click(address()!);
    expect(offer()).not.toBeNull();
    expect(offer()!.textContent).toContain("join without an invite");
    expect(offer()!.textContent).toContain("people who run pqp");
    expect(directory()!.disabled).toBe(false);
    expect(directory()!.checked).toBe(false);
  });

  it("saves an address without a listing unless the owner ticks it", async () => {
    await mount(true);
    await click(address()!);
    const save = [...document.querySelectorAll("button")].find(
      (one) => one.textContent === "Save",
    )!;
    await act(async () => {
      save.click();
    });
    await press(buttonNamed("Make public")!);
    expect(api.updateCommunitySettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isCommunity: true, isListed: false }),
    );
    // Saved: the address is on now, so nothing just happened any more.
    expect(offer()).toBeNull();
  });

  it("lists when the owner ticks the offer", async () => {
    await mount(true);
    await click(address()!);
    await click(directory()!);
    const save = [...document.querySelectorAll("button")].find(
      (one) => one.textContent === "Save",
    )!;
    await act(async () => {
      save.click();
    });
    await press(buttonNamed("Make public and list it")!);
    expect(api.updateCommunitySettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isCommunity: true, isListed: true }),
    );
  });

  it("goes away again when the address is unticked", async () => {
    await mount(true);
    await click(address()!);
    await click(directory()!);
    await click(address()!);
    expect(offer()).toBeNull();
    expect(directory()!.checked).toBe(false);
  });

  it("never offers it to an admin, whose switch stays the owner's", async () => {
    await mount(false);
    await click(address()!);
    expect(offer()).toBeNull();
    expect(directory()!.disabled).toBe(true);
  });

  it("shows no offer on a room whose address was already on", async () => {
    api.fetchCommunitySettings.mockResolvedValue({
      community: { ...SETTINGS, isCommunity: true, slug: "clube" },
    });
    await mount(true);
    expect(address()!.checked).toBe(true);
    expect(offer()).toBeNull();
    expect(directory()!.disabled).toBe(false);
  });
});

const LISTED: CommunitySettings = {
  ...SETTINGS,
  isCommunity: true,
  isListed: true,
  slug: "clube",
};

describe("CommunitySettingsSection: the confirmation before a door opens", () => {
  it("asks before the address goes on, naming the server, and saves nothing yet", async () => {
    await mount(true);
    await click(address()!);
    await press(buttonNamed("Save")!);

    expect(api.updateCommunitySettings).not.toHaveBeenCalled();
    const open = dialog()!;
    expect(open).not.toBeNull();
    expect(open.getAttribute("aria-modal")).toBe("true");
    expect(open.textContent).toContain("Make Servidor de teste public?");
    expect(open.textContent).toContain("every channel that is not restricted");
    expect(open.textContent).toContain("no invite");
  });

  it("puts focus on Cancel, so a stray Enter cannot open the room", async () => {
    await mount(true);
    await click(address()!);
    await press(buttonNamed("Save")!);
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  it("Cancel leaves the room private, the ticks as they were and nothing sent", async () => {
    await mount(true);
    await click(address()!);
    await press(buttonNamed("Save")!);
    await press(buttonNamed("Cancel")!);

    expect(dialog()).toBeNull();
    expect(api.updateCommunitySettings).not.toHaveBeenCalled();
    expect(address()!.checked).toBe(true);
    expect(document.querySelector("[data-community-state]")!.getAttribute(
      "data-community-state",
    )).toBe("private");
  });

  it("Escape closes it the same way, without saving", async () => {
    await mount(true);
    await click(address()!);
    await press(buttonNamed("Save")!);
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(api.updateCommunitySettings).not.toHaveBeenCalled();
  });

  it("confirming saves, and the state card then says the link is public", async () => {
    await mount(true);
    await click(address()!);
    await press(buttonNamed("Save")!);
    await press(buttonNamed("Make public")!);

    expect(api.updateCommunitySettings).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(
      document.querySelector("[data-community-state]")!.getAttribute(
        "data-community-state",
      ),
    ).toBe("public");
  });

  it("asks about the directory alone when the address was already on", async () => {
    api.fetchCommunitySettings.mockResolvedValue({
      community: { ...SETTINGS, isCommunity: true, slug: "clube" },
    });
    await mount(true);
    await click(directory()!);
    await press(buttonNamed("Save")!);

    const open = dialog()!;
    expect(open.textContent).toContain("List Servidor de teste in the directory?");
    expect(open.textContent).toContain("Only you, as the owner");
    await press(buttonNamed("List it")!);
    expect(api.updateCommunitySettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isListed: true }),
    );
  });

  it("never asks to turn the address off", async () => {
    api.fetchCommunitySettings.mockResolvedValue({
      community: { ...LISTED, isListed: false },
    });
    await mount(true);
    await click(address()!);
    await press(buttonNamed("Save")!);

    expect(dialog()).toBeNull();
    expect(api.updateCommunitySettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isCommunity: false }),
    );
  });

  it("never asks to take the room out of the directory", async () => {
    api.fetchCommunitySettings.mockResolvedValue({ community: LISTED });
    await mount(true);
    await click(directory()!);
    await press(buttonNamed("Save")!);

    expect(dialog()).toBeNull();
    expect(api.updateCommunitySettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ isCommunity: true, isListed: false }),
    );
  });

  it("does not ask when a room that is already public saves its tagline", async () => {
    api.fetchCommunitySettings.mockResolvedValue({ community: LISTED });
    await mount(true);
    const tagline = document.querySelector<HTMLInputElement>("input[maxlength]")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      set.call(tagline, "um lugar");
      tagline.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(buttonNamed("Save")!);

    expect(dialog()).toBeNull();
    expect(api.updateCommunitySettings).toHaveBeenCalledTimes(1);
  });
});

describe("CommunitySettingsSection: where the room stands", () => {
  const state = () => document.querySelector("[data-community-state]");

  it("says private for a room with no address", async () => {
    await mount(true);
    expect(state()!.getAttribute("data-community-state")).toBe("private");
    expect(state()!.textContent).toContain("Only people with an invite can join.");
  });

  it("says in the directory for a listed room", async () => {
    api.fetchCommunitySettings.mockResolvedValue({ community: LISTED });
    await mount(true);
    expect(state()!.getAttribute("data-community-state")).toBe("listed");
    expect(state()!.textContent).toContain("In the directory");
  });

  it("reads a suspended community as taken down, not public", async () => {
    api.fetchCommunitySettings.mockResolvedValue({
      community: { ...LISTED, suspended: true },
    });
    await mount(true);
    expect(state()!.getAttribute("data-community-state")).toBe("suspended");
    expect(state()!.textContent).toContain("Taken down");
    expect(state()!.textContent).not.toContain("Public link");
  });
});
