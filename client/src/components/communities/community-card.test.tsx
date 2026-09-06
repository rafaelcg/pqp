import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CommunitySummary } from "@pqp/shared";

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  getApiBaseUrl: () => "https://api.example.test",
}));

const { CommunityCard, cardImageSrc } = await import("./community-card");

function community(
  overrides: Partial<CommunitySummary> = {},
): CommunitySummary {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Deu Merge",
    slug: "deu-merge",
    tagline: "A sala",
    category: "tech",
    language: "pt",
    memberCount: 12,
    joined: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    iconUrl: null,
    bannerUrl: null,
    ...overrides,
  };
}

function renderCard(overrides: Partial<CommunitySummary> = {}) {
  return renderToStaticMarkup(
    <CommunityCard
      community={community(overrides)}
      joining={false}
      onEnter={() => {}}
      onReport={() => {}}
      iconUrl={overrides.iconUrl ?? null}
      bannerUrl={overrides.bannerUrl ?? null}
    />,
  );
}

/**
 * The directory card's pictures, on the paths that produce a broken-file
 * glyph today: a root-relative upload (the hosted case), an empty string, a
 * scheme we will not load, and a URL that already failed.
 */

describe("cardImageSrc", () => {
  it("is null for a missing, empty, or whitespace value — no <img> to break", () => {
    expect(cardImageSrc(null)).toBeNull();
    expect(cardImageSrc(undefined)).toBeNull();
    expect(cardImageSrc("")).toBeNull();
    expect(cardImageSrc("   ")).toBeNull();
  });

  it("prefixes the API origin onto this deployment's own icon path", () => {
    // The SPA and the API are two origins; a bare `/api/servers/…/icon` asks
    // Cloudflare Pages for a picture only the API has.
    expect(cardImageSrc("/api/servers/abc/icon?v=deadbeef")).toBe(
      "https://api.example.test/api/servers/abc/icon?v=deadbeef",
    );
  });

  it("keeps an https URL", () => {
    expect(cardImageSrc("https://cdn.example.com/a.png")).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("refuses a scheme it will not load", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "http://cdn.example.com/a.png",
    ]) {
      expect(cardImageSrc(hostile)).toBeNull();
    }
  });

  it("treats a URL that already failed as absent, so the monogram paints", () => {
    const src = "https://cdn.example.com/gone.png";
    expect(cardImageSrc(src, src)).toBeNull();
    expect(cardImageSrc("/api/servers/abc/icon", "https://api.example.test/api/servers/abc/icon")).toBeNull();
  });
});

describe("CommunityCard images", () => {
  it("draws the monogram when there is no icon, and never an <img>", () => {
    const html = renderCard({ iconUrl: null });
    expect(html).toContain(">DM<");
    expect(html).not.toContain("<img");
  });

  it("draws the monogram for an empty src rather than a broken <img>", () => {
    const html = renderCard({ iconUrl: "" });
    expect(html).toContain(">DM<");
    expect(html).not.toContain("<img");
  });

  it("draws the monogram for a scheme it will not load", () => {
    const html = renderCard({ iconUrl: "javascript:alert(1)" });
    expect(html).toContain(">DM<");
    expect(html).not.toContain("<img");
  });

  it("points an uploaded icon at the API origin, and keeps the monogram until it loads", () => {
    // Invisible until `onLoad` is what stops a 404 from painting the browser's
    // broken-file glyph over the initials (and over the category chip, when
    // the dead URL was a banner). Static markup never fires `onLoad`, so both
    // the img and the letters are present — that is the in-flight state.
    const html = renderCard({
      iconUrl: "/api/servers/abc/icon?v=deadbeef",
    });
    expect(html).toContain(
      'src="https://api.example.test/api/servers/abc/icon?v=deadbeef"',
    );
    expect(html).toContain("invisible");
    expect(html).toContain(">DM<");
  });

  it("sends no referrer with the image request", () => {
    const html = renderCard({
      iconUrl: "https://cdn.example.com/a.png",
    });
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("keeps the Tech chip as the category glyph, never an <img>", () => {
    // A failed banner used to paint the browser's broken-file icon in the
    // header, next to the category label, which made Tech look broken on the
    // one card that had a dead banner and fine on the neighbour that did not.
    const html = renderCard({
      category: "tech",
      bannerUrl: "javascript:alert(1)",
    });
    expect(html).toContain("💻");
    expect(html).toContain("Tech");
    expect(html).not.toContain("<img");
  });

  it("does not render a banner <img> for an empty src", () => {
    const html = renderCard({ bannerUrl: "" });
    expect(html).not.toContain("<img");
  });
});
