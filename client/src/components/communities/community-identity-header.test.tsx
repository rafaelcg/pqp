import type { Server } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CommunityIdentityHeader,
  CommunityIdentityRail,
  type CommunityIdentityEdit,
} from "./community-identity-header";

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  getApiBaseUrl: () => "https://api.example.test",
}));

const server: Pick<
  Server,
  | "name"
  | "iconUrl"
  | "bannerUrl"
  | "communityTagline"
  | "communityAbout"
  | "communityLinks"
  | "communitySlug"
> = {
  name: "Mesa",
  iconUrl: null,
  bannerUrl: null,
  communityTagline: "RPG tático com os amigos",
  communityAbout: "Sessão terça, 20h.",
  communityLinks: [{ kind: "youtube", url: "https://youtube.com/@mesa" }],
  communitySlug: "sandbox",
};

const idleEdit: CommunityIdentityEdit = {
  draft: { tagline: "", about: "", linkUrls: [] },
  saving: false,
  uploadsEnabled: true,
  imageBusy: null,
  onChange: () => {},
  onPickImage: () => {},
  onRemoveImage: () => {},
  onError: () => {},
};

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  return renderToStaticMarkup(node);
}

describe("CommunityIdentityHeader", () => {
  it("a missing cover paints the pqp.gg mosaic, not a photo", () => {
    const html = render(<CommunityIdentityHeader server={server} />);
    expect(html).toContain("data-hero-mosaic");
    expect(html).toContain("pqp.gg");
    expect(html).not.toContain("<img");
  });

  it("an uploaded cover replaces the mosaic", () => {
    const html = render(
      <CommunityIdentityHeader
        server={{ ...server, bannerUrl: "/api/servers/s1/banner?v=1" }}
      />,
    );
    expect(html).not.toContain("data-hero-mosaic");
    expect(html).toContain("/api/servers/s1/banner?v=1");
  });

  it("members do not get an edit control", () => {
    const html = render(<CommunityIdentityHeader server={server} />);
    expect(html).not.toContain("data-identity-edit-start");
    expect(html).not.toContain("data-identity-cover-edit");
    expect(html).toContain("RPG tático com os amigos");
    expect(html).toContain("Sessão terça, 20h.");
  });

  it("staff see Edit page on the cover", () => {
    const html = render(
      <CommunityIdentityHeader
        server={server}
        canManageServer
        onStartEdit={() => {}}
      />,
    );
    expect(html).toContain("data-identity-edit-start");
    expect(html).toContain("Edit page");
    expect(html).not.toContain("data-identity-cover-edit");
  });

  it("staff compose can sit on the cover next to Edit page", () => {
    const html = render(
      <CommunityIdentityHeader
        server={server}
        canManageServer
        onStartEdit={() => {}}
        bannerEnd={<span data-home-staff-pen>New post</span>}
      />,
    );
    expect(html).toContain("data-home-staff-pen");
    expect(html).toContain("New post");
    expect(html).toContain("Edit page");
  });

  it("edit mode shows cover, icon, tagline, about and links even when they are empty", () => {
    const html = render(
      <CommunityIdentityHeader
        server={{
          ...server,
          communityTagline: null,
          communityAbout: null,
          communityLinks: [],
        }}
        canManageServer
        edit={idleEdit}
      />,
    );
    expect(html).toContain('data-identity-editing="1"');
    expect(html).toContain("data-identity-cover-edit");
    expect(html).toContain("data-identity-icon-edit");
    expect(html).toContain("data-identity-tagline-input");
    expect(html).toContain("data-identity-about-input");
    expect(html).toContain("data-identity-links-add");
    expect(html).toContain("Add cover");
    expect(html).not.toContain("Edit page");
  });

  it("edit mode keeps the mosaic and lists crop sizes", () => {
    const html = render(
      <CommunityIdentityHeader server={server} canManageServer edit={idleEdit} />,
    );
    expect(html).toContain("data-hero-mosaic");
    expect(html).toContain("data-identity-cover-size");
    expect(html).toContain("1024×480");
    expect(html).toContain("512×512");
    expect(html).toContain("data-identity-cover-hint");
    expect(html).toContain("data-identity-icon-hint");
    expect(html).toContain("wait for Save");
    expect(html).toContain("JPG, PNG or WebP");
  });

  it("with no storage, the cover says so and still lists sizes", () => {
    const html = render(
      <CommunityIdentityHeader
        server={server}
        canManageServer
        edit={{ ...idleEdit, uploadsEnabled: false }}
      />,
    );
    expect(html).toContain("Pictures cannot be uploaded");
    expect(html).not.toContain("wait for Save");
    expect(html).not.toContain("data-identity-icon-edit");
    expect(html).toContain("1024×480");
    expect(html).toContain("512×512");
  });

  it("compact view keeps about and links out of the header", () => {
    const html = render(
      <CommunityIdentityHeader server={server} layout="compact" />,
    );
    expect(html).toContain("RPG tático com os amigos");
    expect(html).not.toContain("Sessão terça, 20h.");
    expect(html).not.toContain("data-community-links");
  });

  it("the rail puts official links under about", () => {
    const html = render(
      <CommunityIdentityRail
        about="Sessão terça, 20h."
        links={server.communityLinks}
        aboutLines={8}
      />,
    );
    const aboutAt = html.indexOf("Sessão terça, 20h.");
    const linksAt = html.indexOf("data-community-links");
    expect(aboutAt).toBeGreaterThan(-1);
    expect(linksAt).toBeGreaterThan(aboutAt);
  });

  it("does not offer Turn Baú on when the instance flag is off", () => {
    const html = render(
      <CommunityIdentityHeader
        server={server}
        canManageServer
        feedAvailable={false}
        homeFeatureOn={false}
        onOpenServerSettings={() => {}}
      />,
    );
    expect(html).not.toContain("data-identity-turn-on");
  });

  it("offers Turn Baú on when the instance flag is on and the feed is off", () => {
    const html = render(
      <CommunityIdentityHeader
        server={server}
        canManageServer
        feedAvailable={false}
        homeFeatureOn
        onOpenServerSettings={() => {}}
      />,
    );
    expect(html).toContain("data-identity-turn-on");
    expect(html).toContain("Turn Baú on");
  });
});
