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
