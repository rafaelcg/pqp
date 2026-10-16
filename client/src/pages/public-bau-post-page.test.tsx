// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { PublicBauPostResponse } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The marketing nav and the page's own Clerk buttons need a ClerkProvider this
// test does not set up. Signed out is the case under test; the signed-in
// branch is reached through the dev bypass, which is what skips Clerk.
vi.mock("@clerk/clerk-react", () => ({
  SignUpButton: ({ children }: { children: React.ReactNode }) => children,
  SignedIn: () => null,
  SignedOut: ({ children }: { children: React.ReactNode }) => children,
  useClerk: () => ({ loaded: false }),
  useAuth: () => ({ getToken: async () => "t" }),
}));
vi.mock("@/components/marketing/marketing-auth-ctas", () => ({
  MarketingAuthCtas: () => null,
}));
vi.mock("@/components/marketing/marketing-nav", () => ({
  MarketingNav: () => null,
}));
vi.mock("@/components/marketing/marketing-footer", () => ({
  MarketingFooter: () => null,
}));

const api = vi.hoisted(() => ({
  fetchPublicBauPost: vi.fn(),
  fetchPublicCommunity: vi.fn(),
  lookupCommunityMembership: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import { I18nProvider } from "@/lib/i18n";
import { PublicBauPostPage } from "./public-bau-post-page";

const POST_ID = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";
const SERVER_ID = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab";

const COMMUNITY = {
  slug: "mesa-da-tues",
  name: "Mesa da Tues",
  tagline: "A mesa de quem joga",
  about: null,
  links: [],
  featured: null,
  category: "games" as const,
  memberCount: 1240,
  iconUrl: null,
  bannerUrl: null,
  createdMonth: "2026-07",
};

const ANSWER: PublicBauPostResponse = {
  post: {
    id: POST_ID,
    title: "Patch 1.2 saiu",
    body: "A gente mexeu no mapa inteiro.",
    teaser: "A gente mexeu no mapa inteiro.",
    media: null,
    posterUrl: null,
    coverUrl: null,
    coverType: null,
    coverWidth: null,
    coverHeight: null,
    coverBytes: null,
    likeCount: 7,
    commentCount: 2,
    publishedAt: "2026-10-15T07:29:48.569Z",
    channels: [],
    publicUrl: `https://pqp.gg/c/mesa-da-tues/p/${POST_ID}`,
  },
  community: COMMUNITY,
};

const OPEN_CHANNEL = "5b0f3e2a-6c1d-4a3e-8d57-0a1b2c3d4e5f";
const REDACTED = "00000000-0000-0000-0000-000000000000";

let host: HTMLDivElement;
let unmount: () => void;

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <PublicBauPostPage slug="mesa-da-tues" postId={POST_ID} />
        </MemoryRouter>
      </I18nProvider>,
    );
  });
  // The page's own fetches settle one microtask apart.
  await act(async () => {
    await Promise.resolve();
  });
  unmount = () => act(() => root.unmount());
}

describe("PublicBauPostPage", () => {
  beforeEach(() => {
    localStorage.clear();
    api.fetchPublicBauPost.mockReset();
    api.fetchPublicCommunity.mockReset();
    api.lookupCommunityMembership.mockReset();
    // Signed out unless a case says otherwise. A developer's `client/.env`
    // may switch the bypass on, and then every case would take the other branch.
    vi.stubEnv("VITE_DEV_AUTH_BYPASS", "false");
    // A phone with no sheet and a desktop's pointer: the menu shape.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });

  afterEach(() => {
    unmount?.();
    host?.remove();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("draws the post, the counts, Compartilhar and the community's way in, with no account", async () => {
    api.fetchPublicBauPost.mockResolvedValue(ANSWER);
    await mount();

    expect(host.querySelector("h1")?.textContent).toBe("Patch 1.2 saiu");
    expect(host.textContent).toContain("A gente mexeu no mapa inteiro.");
    expect(host.querySelector("[data-public-bau-likes]")?.getAttribute("aria-label")).toBe("7 likes");
    expect(host.querySelector("[data-public-bau-comments]")?.getAttribute("aria-label")).toBe(
      "2 comments",
    );
    expect(host.querySelector('[data-bau-share="page"]')).not.toBeNull();

    const cta = host.querySelector("[data-public-bau-cta]")!;
    expect(cta.textContent).toContain("Mesa da Tues");
    expect(cta.textContent).toContain("1,240 members");
    expect(cta.querySelector("[data-public-bau-join]")?.textContent).toContain(
      "Join the community",
    );
    // No author row, no comment words: the page has no field to draw them from.
    expect(host.querySelector("[data-home-post]")).toBeNull();
  });

  it("draws a channel mention as a neutral pill: the name when everybody can see it, a plain #channel when not, never an error", async () => {
    api.fetchPublicBauPost.mockResolvedValue({
      ...ANSWER,
      post: {
        ...ANSWER.post,
        body: `Passa em <#${OPEN_CHANNEL}> e em <#${REDACTED}> pra contar.`,
        channels: [{ id: OPEN_CHANNEL, name: "anuncios" }],
      },
    });
    await mount();
    const pills = [...host.querySelectorAll("[data-home-channel-ref]")];
    expect(pills.map((pill) => [pill.getAttribute("data-home-channel-ref"), pill.textContent])).toEqual([
      ["public-name", "#anuncios"],
      ["public-generic", "#channel"],
    ]);
    // Neither is a link, and nothing says "unavailable".
    expect(host.querySelector("a[data-home-channel-ref]")).toBeNull();
    expect(host.textContent?.toLowerCase()).not.toContain("unavailable");
    expect(host.textContent).toContain("Passa em #anuncios e em #channel pra contar.");
  });

  it("the CTA carries the slug through sign-up as the join intent", async () => {
    api.fetchPublicBauPost.mockResolvedValue(ANSWER);
    await mount();
    const join = host.querySelector<HTMLButtonElement>("[data-public-bau-join]")!;
    await act(async () => {
      join.click();
    });
    const stashed = JSON.parse(localStorage.getItem("pqp:pending-community-join") ?? "null");
    expect(JSON.stringify(stashed)).toContain("mesa-da-tues");
  });

  it("a post that is not public is one friendly 404 that still offers the community", async () => {
    api.fetchPublicBauPost.mockResolvedValue(null);
    api.fetchPublicCommunity.mockResolvedValue(COMMUNITY);
    await mount();

    expect(host.querySelector("h1")?.textContent).toBe("This post is not here.");
    expect(host.querySelector("[data-public-bau-missing-community]")).not.toBeNull();
    expect(host.textContent).toContain("But Mesa da Tues is still here.");
    expect(host.querySelector("[data-public-bau-join]")).not.toBeNull();
    // The page is kept out of the index.
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toContain(
      "noindex",
    );
  });

  it("with no public community either, it is a plain 404 with a way into the product", async () => {
    api.fetchPublicBauPost.mockResolvedValue(null);
    api.fetchPublicCommunity.mockResolvedValue(null);
    await mount();
    expect(host.querySelector("h1")?.textContent).toBe("This post is not here.");
    expect(host.querySelector("[data-public-bau-cta]")).toBeNull();
    expect(host.querySelector('a[href="/app"]')).not.toBeNull();
  });

  it("a dropped connection is not a dead link: it offers a retry instead", async () => {
    api.fetchPublicBauPost.mockRejectedValue(new Error("offline"));
    await mount();
    expect(host.querySelector("h1")?.textContent).toBe("Could not load that post");
    expect(host.textContent).not.toContain("This post is not here.");

    api.fetchPublicBauPost.mockResolvedValue(ANSWER);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => {
      retry.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.querySelector("h1")?.textContent).toBe("Patch 1.2 saiu");
  });

  describe("signed in (dev bypass skips Clerk)", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_DEV_AUTH_BYPASS", "true");
      api.fetchPublicBauPost.mockResolvedValue(ANSWER);
    });

    it("a member gets Abrir no app, straight onto the post", async () => {
      api.lookupCommunityMembership.mockResolvedValue({
        serverId: SERVER_ID,
        joined: true,
      });
      await mount();
      const open = host.querySelector<HTMLAnchorElement>("[data-public-bau-open]");
      expect(open?.getAttribute("href")).toBe(`/app/server/${SERVER_ID}/bau/${POST_ID}`);
      expect(host.querySelector("[data-public-bau-join]")).toBeNull();
    });

    it("anybody else gets the join button, which lands in the community", async () => {
      api.lookupCommunityMembership.mockResolvedValue({
        serverId: SERVER_ID,
        joined: false,
      });
      await mount();
      expect(host.querySelector("[data-public-bau-open]")).toBeNull();
      expect(
        host.querySelector("[data-public-bau-join]")?.getAttribute("href"),
      ).toBe("/app?join=mesa-da-tues");
    });

    it("keeps the join button when the lookup fails", async () => {
      api.lookupCommunityMembership.mockResolvedValue(null);
      await mount();
      expect(host.querySelector("[data-public-bau-join]")).not.toBeNull();
    });
  });
});
