import type { CommunityHomePost } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  claimCommunityHomeMediaUpload: vi.fn(),
  createCommunityHomeComment: vi.fn(),
  createCommunityHomeMediaUpload: vi.fn(),
  createCommunityHomePost: vi.fn(),
  deleteCommunityHomeComment: vi.fn(),
  deleteCommunityHomePost: vi.fn(),
  fetchCommunityHomeComments: vi.fn(),
  fetchCommunityHomeDrafts: vi.fn(),
  fetchCommunityHomeMediaConfig: vi.fn(),
  fetchCommunityHomePost: vi.fn(),
  fetchCommunityHomePosts: vi.fn(),
  publishCommunityHomePost: vi.fn(),
  scheduleCommunityHomePost: vi.fn(),
  toggleCommunityHomeLike: vi.fn(),
  unpublishCommunityHomePost: vi.fn(),
  updateCommunityHomePost: vi.fn(),
}));

vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    locale: "en",
    t: (key: string, vars?: { count?: number }) =>
      key === "communityHome.comments"
        ? `${vars?.count ?? 0} comments`
        : key,
  }),
}));

const api = await import("@/lib/api");
const {
  CommunityHomeFeed,
  CommunityHomeFeedContent,
} = await import("./community-home-feed");

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const AUTHOR_ID = "22222222-2222-4222-8222-222222222222";

function post(
  overrides: Partial<CommunityHomePost> = {},
): CommunityHomePost {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    serverId: SERVER_ID,
    author: {
      id: AUTHOR_ID,
      displayName: "Raf",
      username: "raf",
      tag: "raf#1234",
      avatarUrl: null,
    },
    authorBadge: "owner",
    title: "A post",
    body: "The full body",
    teaser: null,
    visibility: "free",
    status: "published",
    commentsEnabled: true,
    media: {
      kind: "image",
      name: "photo.webp",
      contentType: "image/webp",
      byteSize: 1024,
      url: "https://media.example/free-photo.webp",
      youtubeUrl: null,
    },
    locked: false,
    likeCount: 0,
    likedByMe: false,
    commentCount: 0,
    commentTeaser: [],
    scheduledAt: null,
    scheduleTimezone: null,
    publishedAt: "2026-09-01T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("CommunityHomeFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders API posts without leaking locked media URLs", async () => {
    const freePost = post();
    const lockedPost = post({
      id: "44444444-4444-4444-8444-444444444444",
      title: "Members archive",
      body: null,
      teaser: "A look at what is inside",
      visibility: "members",
      locked: true,
      media: {
        kind: "video",
        name: "members.webm",
        contentType: "video/webm",
        byteSize: 2048,
        url: "https://media.example/private-members.webm",
        youtubeUrl: null,
      },
    });
    vi.mocked(api.fetchCommunityHomePosts).mockResolvedValue({
      posts: [freePost, lockedPost],
    });

    const response = await api.fetchCommunityHomePosts(SERVER_ID);
    const html = renderToStaticMarkup(
      <CommunityHomeFeedContent
        posts={response.posts}
        canManageServer={false}
      />,
    );

    expect(api.fetchCommunityHomePosts).toHaveBeenCalledWith(SERVER_ID);
    expect(html).toContain("https://media.example/free-photo.webp");
    expect(html).toContain("data-home-locked-media");
    expect(html).not.toContain("https://media.example/private-members.webm");
  });

  it("has locked header chrome without Compose or Preview tabs", () => {
    const html = renderToStaticMarkup(
      <CommunityHomeFeed
        serverId={SERVER_ID}
        serverName="Mesa"
        authorName="Raf"
        canManageServer
        isOwner
        isVip={false}
        currentUserId={AUTHOR_ID}
      />,
    );

    expect(html).toContain("data-home-staff-pen");
    expect(html).toContain("data-home-staff-overflow");
    expect(html).not.toContain("data-home-staff-tabs");
  });

  it("renders the quiet empty-state copy when the API has no posts", () => {
    const html = renderToStaticMarkup(
      <CommunityHomeFeedContent
        posts={[]}
        canManageServer={false}
      />,
    );

    expect(html).toContain("data-home-empty");
    expect(html).toContain("communityHome.empty.body");
  });
});
