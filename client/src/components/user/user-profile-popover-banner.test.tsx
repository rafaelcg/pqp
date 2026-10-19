// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The banner on the profile card that opens from a name inside a server.
 *
 * Reported by a player: somebody set a banner and the card in the server never
 * showed it, because no in-app payload carried it and the card drew a fixed
 * gradient. The card now reads it when it opens. What this pins:
 *
 *   * THE ADDRESS IS RESOLVED AGAINST THE API. A banner URL is root-relative,
 *     and on every hosted deployment the SPA and the API are two origins. The
 *     avatar on this same card shipped once without that and drew a broken
 *     image (`e2e/profile-popover-avatar.spec.ts`).
 *   * THE BAND IS ONE SIZE. With and without a banner, so the card measured on
 *     open is still the card on screen once the picture arrives.
 *   * A FAILED BANNER READ COSTS ONLY THE BANNER. The web client ships before
 *     the API, so the route can 404 for a while after a deploy; the rest of the
 *     card must still render.
 */

const API_BASE = "https://api.example.test";
vi.stubEnv("VITE_API_URL", API_BASE);

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRUNO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CARLA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BANNER = `/api/users/${BRUNO}/banner?v=abcd1234`;

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchUserBannerUrl: vi.fn(),
  fetchUserAchievements: vi.fn(() => Promise.resolve({ achievements: [] })),
  fetchUserConnections: vi.fn(() => Promise.resolve({ connections: [] })),
}));

vi.mock("@/components/depoimentos/depoimentos-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/depoimentos/depoimentos-api")
  >()),
  fetchDepoimentos: vi.fn(() =>
    Promise.resolve({
      depoimentos: [
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          author: {
            id: ANA,
            displayName: "Ana",
            username: "ana",
            tag: "ana#0001",
            avatarUrl: null,
            customStatus: null,
          },
          body: "parceiro de call",
          createdAt: "2026-10-01T00:00:00.000Z",
          approvedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    }),
  ),
  fetchProfileCommunities: vi.fn(() =>
    Promise.resolve({ communities: [], total: 0 }),
  ),
}));

const { ProfilePopoverProvider, useProfilePopover } = await import(
  "./user-profile-popover"
);
const { fetchUserBannerUrl } = await import("@/lib/api");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.mocked(fetchUserBannerUrl).mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Opener() {
  const open = useProfilePopover();
  return (
    <>
      {[
        { id: BRUNO, displayName: "Bruno", tag: "bruno#0002" },
        { id: CARLA, displayName: "Carla", tag: "carla#0003" },
      ].map((person) => (
        <button
          key={person.id}
          type="button"
          data-opener={person.displayName}
          onClick={(event) =>
            open({ ...person, avatarUrl: null }, event.currentTarget)
          }
        >
          {person.displayName}
        </button>
      ))}
    </>
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openCard(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ProfilePopoverProvider
        currentUserId={ANA}
        blockedUserIds={new Set<string>()}
        moderation={null}
        onOpenConversation={() => {}}
        onBlockUser={() => {}}
        onUnblockUser={() => {}}
        onReportUser={() => {}}
      >
        <Opener />
      </ProfilePopoverProvider>,
    );
  });
  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[data-opener="Bruno"]')!.click();
  });
  // Let every read the card fires on open settle.
  await settle();
  const card = document.body.querySelector<HTMLElement>("[data-profile-card]");
  expect(card).not.toBeNull();
  return card!;
}

function band(card: HTMLElement): HTMLElement {
  const node = card.querySelector<HTMLElement>("[data-profile-banner]");
  expect(node).not.toBeNull();
  return node!;
}

describe("profile card banner", () => {
  it("draws the banner, resolved against the API origin", async () => {
    vi.mocked(fetchUserBannerUrl).mockResolvedValue({ bannerUrl: BANNER });
    const card = await openCard();

    expect(fetchUserBannerUrl).toHaveBeenCalledWith(BRUNO);
    const image = band(card).querySelector("img");
    expect(band(card).dataset.profileBanner).toBe("image");
    expect(image?.getAttribute("src")).toBe(`${API_BASE}${BANNER}`);
    // Decorative: the card is already labelled with the person's name.
    expect(image?.getAttribute("alt")).toBe("");
    expect(band(card).getAttribute("aria-hidden")).toBe("true");

    // Hidden until the picture arrives, then faded in over the gradient.
    expect(image?.className).toContain("opacity-0");
    await act(async () => {
      image!.dispatchEvent(new Event("load"));
    });
    expect(image?.className).toContain("opacity-100");
    expect(image?.className).not.toContain("opacity-0");
  });

  it("keeps the generated band, at the same size, when there is no banner", async () => {
    vi.mocked(fetchUserBannerUrl).mockResolvedValue({ bannerUrl: BANNER });
    const withBanner = band(await openCard()).style.aspectRatio;
    act(() => root?.unmount());
    host?.remove();

    vi.mocked(fetchUserBannerUrl).mockResolvedValue({ bannerUrl: null });
    const card = await openCard();

    expect(band(card).dataset.profileBanner).toBe("generated");
    expect(band(card).querySelector("img")).toBeNull();
    // The banner's own 3:1 in both states, so nothing moves when it loads.
    expect(band(card).style.aspectRatio).toBe("1500 / 500");
    expect(withBanner).toBe("1500 / 500");
  });

  it("costs the card only the picture when the banner read fails", async () => {
    vi.mocked(fetchUserBannerUrl).mockRejectedValue(new Error("404"));
    const card = await openCard();

    expect(band(card).dataset.profileBanner).toBe("generated");
    expect(band(card).querySelector("img")).toBeNull();
    // The depoimentos read is separate and still lands.
    expect(card.querySelector("[data-depoimentos]")?.textContent).toContain(
      "parceiro de call",
    );
  });

  it("falls back to the generated band when the image itself fails", async () => {
    vi.mocked(fetchUserBannerUrl).mockResolvedValue({ bannerUrl: BANNER });
    const card = await openCard();
    const image = band(card).querySelector("img")!;

    await act(async () => {
      image.dispatchEvent(new Event("error"));
    });

    expect(band(card).dataset.profileBanner).toBe("generated");
    expect(band(card).querySelector("img")).toBeNull();
  });

  it("never draws the last person's banner on the next one", async () => {
    vi.mocked(fetchUserBannerUrl).mockResolvedValueOnce({ bannerUrl: BANNER });
    expect(band(await openCard()).dataset.profileBanner).toBe("image");

    // Carla's read fails: her card must not keep Bruno's picture.
    vi.mocked(fetchUserBannerUrl).mockRejectedValueOnce(new Error("404"));
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-opener="Carla"]')!.click();
    });
    await settle();

    expect(fetchUserBannerUrl).toHaveBeenLastCalledWith(CARLA);
    const card = document.body.querySelector<HTMLElement>("[data-profile-card]")!;
    expect(card.textContent).toContain("Carla");
    expect(band(card).dataset.profileBanner).toBe("generated");
    expect(band(card).querySelector("img")).toBeNull();

    // Back to Bruno, and this read fails too: the picture from his first
    // visit is not drawn again.
    vi.mocked(fetchUserBannerUrl).mockRejectedValueOnce(new Error("404"));
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-opener="Bruno"]')!.click();
    });
    await settle();

    expect(fetchUserBannerUrl).toHaveBeenLastCalledWith(BRUNO);
    const again = document.body.querySelector<HTMLElement>("[data-profile-card]")!;
    expect(again.textContent).toContain("Bruno");
    expect(band(again).dataset.profileBanner).toBe("generated");
  });

  it("refuses a banner address that is neither ours nor https", async () => {
    vi.mocked(fetchUserBannerUrl).mockResolvedValue({
      bannerUrl: "javascript:alert(1)",
    });
    const card = await openCard();

    expect(band(card).querySelector("img")).toBeNull();
  });
});
