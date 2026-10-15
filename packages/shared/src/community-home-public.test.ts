import { describe, expect, it } from "vitest";
import {
  BAU_SHARE_SOURCES,
  bauPublicPostPath,
  bauShareUrl,
  parseBauPublicPostPath,
  publicBauPostResponseSchema,
} from "./community-home-public.js";

const POST = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";

describe("bauPublicPostPath / parseBauPublicPostPath", () => {
  it("round-trips", () => {
    const path = bauPublicPostPath("mesa-da-tues", POST);
    expect(path).toBe(`/c/mesa-da-tues/p/${POST}`);
    expect(parseBauPublicPostPath(path)).toEqual({ slug: "mesa-da-tues", postId: POST });
    expect(parseBauPublicPostPath(`${path}/`)).toEqual({ slug: "mesa-da-tues", postId: POST });
  });

  it("lowercases both halves so a shouted link still finds the row", () => {
    expect(
      parseBauPublicPostPath(`/c/MESA-DA-TUES/p/${POST.toUpperCase()}`),
    ).toEqual({ slug: "mesa-da-tues", postId: POST });
  });

  it("refuses anything that is not a post address", () => {
    expect(parseBauPublicPostPath("/c/mesa-da-tues")).toBeNull();
    expect(parseBauPublicPostPath("/c/mesa-da-tues/p")).toBeNull();
    expect(parseBauPublicPostPath("/c/mesa-da-tues/p/not-a-uuid")).toBeNull();
    expect(parseBauPublicPostPath(`/c/mesa-da-tues/p/${POST}/extra`)).toBeNull();
    expect(parseBauPublicPostPath(`/c/-/p/${POST}`)).toBeNull();
    expect(parseBauPublicPostPath(`/c/a/p/${POST}`)).toBeNull();
    expect(parseBauPublicPostPath(`/c/%E0%A4%A/p/${POST}`)).toBeNull();
    expect(parseBauPublicPostPath(`/app/c/mesa-da-tues/p/${POST}`)).toBeNull();
    // The in-app permalink is a different address with a different audience.
    expect(parseBauPublicPostPath(`/app/server/${POST}/bau/${POST}`)).toBeNull();
  });
});

describe("bauShareUrl", () => {
  const url = `https://pqp.gg/c/mesa-da-tues/p/${POST}`;

  it("carries the campaign the acquisition capture reads, one per network", () => {
    for (const source of BAU_SHARE_SOURCES) {
      const shared = new URL(bauShareUrl(url, source));
      expect(shared.origin + shared.pathname).toBe(url);
      expect(shared.searchParams.get("utm_source")).toBe(source);
      expect(shared.searchParams.get("utm_medium")).toBe("share");
      expect(shared.searchParams.get("utm_campaign")).toBe("bau");
    }
  });

  it("replaces a campaign already on the link instead of stacking two", () => {
    const shared = new URL(bauShareUrl(`${url}?utm_source=x&keep=1`, "reddit"));
    expect(shared.searchParams.getAll("utm_source")).toEqual(["reddit"]);
    expect(shared.searchParams.get("keep")).toBe("1");
  });
});

describe("publicBauPostResponseSchema", () => {
  it("parses a minimal answer and defaults what an older API omits", () => {
    const parsed = publicBauPostResponseSchema.parse({
      post: {
        id: POST,
        title: "Patch",
        body: "texto",
        teaser: null,
        media: null,
        likeCount: 0,
        commentCount: 0,
        publishedAt: null,
      },
      community: {
        slug: "mesa-da-tues",
        name: "Mesa da Tues",
        tagline: null,
        category: "geral",
        memberCount: 3,
      },
    });
    expect(parsed.post.posterUrl).toBeNull();
    expect(parsed.post.coverUrl).toBeNull();
    expect(parsed.community.links).toEqual([]);
  });
});
