import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatServerMessageSchema } from "@pqp/shared";

/**
 * The `stories-update` fan-out: who gets it, how often, and that it crosses
 * instances. Sockets, members and the bus are stand-ins; what is under test is
 * the addressing and the coalescing.
 */

const fake = vi.hoisted(() => ({
  sockets: [] as Array<{ userId: string; sent: string[] }>,
  members: new Map<string, string[]>(),
  friends: new Map<string, string[]>(),
  published: [] as Array<{ topic: string; data: unknown }>,
  handler: null as ((data: unknown, origin: string) => void) | null,
  busOn: true,
}));

vi.mock("./sockets.js", () => ({
  forEachAuthenticatedSocket: (
    callback: (socket: { readyState: number; send: (p: string) => void }, user: { id: string }) => void,
  ) => {
    for (const entry of fake.sockets) {
      callback({ readyState: 1, send: (p) => entry.sent.push(p) }, { id: entry.userId });
    }
  },
  forEachSocketOfUser: (
    userId: string,
    callback: (socket: { readyState: number; send: (p: string) => void }) => void,
  ) => {
    for (const entry of fake.sockets.filter((s) => s.userId === userId)) {
      callback({ readyState: 1, send: (p) => entry.sent.push(p) });
    }
  },
}));
vi.mock("../services/permissions.js", () => ({
  listServerMemberIds: async (serverId: string) => fake.members.get(serverId) ?? [],
}));
vi.mock("../services/stories.js", () => ({
  listFriendIds: async (userId: string) => fake.friends.get(userId) ?? [],
}));
vi.mock("../lib/bus.js", () => ({
  isBusEnabled: () => fake.busOn,
  publishToCluster: (topic: string, data: unknown) => fake.published.push({ topic, data }),
  subscribeToCluster: (_topic: string, handler: (data: unknown, origin: string) => void) => {
    fake.handler = handler;
  },
}));

const { notifyStoriesUpdate, notifyStoryAudiences, resetStoriesNotifyForTests, STORIES_TOPIC } =
  await import("./stories.js");

const SERVER = "11111111-1111-4111-8111-111111111111";
const STORY_A = "22222222-2222-4222-8222-222222222222";
const STORY_B = "33333333-3333-4333-8333-333333333333";

function frames(userId: string): unknown[] {
  return fake.sockets
    .filter((s) => s.userId === userId)
    .flatMap((s) => s.sent.map((p) => JSON.parse(p) as unknown));
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("stories-update", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStoriesNotifyForTests();
    fake.sockets = [
      { userId: "member", sent: [] },
      { userId: "stranger", sent: [] },
      { userId: "friend", sent: [] },
      { userId: "author", sent: [] },
    ];
    fake.members = new Map([[SERVER, ["member", "author"]]]);
    fake.friends = new Map([["author", ["friend"]]]);
    fake.published = [];
    fake.busOn = true;
  });

  afterEach(() => {
    resetStoriesNotifyForTests();
    vi.useRealTimers();
  });

  it("reaches a server's members and nobody else, as a frame clients parse", async () => {
    notifyStoriesUpdate({ scope: "server", serverId: SERVER });
    await settle();
    expect(frames("member")).toEqual([{ type: "stories-update", scope: "server", serverId: SERVER }]);
    expect(frames("stranger")).toEqual([]);
    expect(chatServerMessageSchema.safeParse(frames("member")[0]).success).toBe(true);
    expect(fake.published).toEqual([
      { topic: STORIES_TOPIC, data: { type: "stories-update", scope: "server", serverId: SERVER } },
    ]);
  });

  it("coalesces a burst into the first frame and one trailing frame", async () => {
    notifyStoriesUpdate({ scope: "server", serverId: SERVER });
    notifyStoriesUpdate({ scope: "server", serverId: SERVER }, [STORY_A]);
    notifyStoriesUpdate({ scope: "server", serverId: SERVER }, [STORY_B]);
    await settle();
    expect(frames("member")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames("member")).toEqual([
      { type: "stories-update", scope: "server", serverId: SERVER },
      { type: "stories-update", scope: "server", serverId: SERVER, removedStoryIds: [STORY_A, STORY_B] },
    ]);
    // A quiet window sends nothing more.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(frames("member")).toHaveLength(2);
  });

  it("an author's own sockets get at most one frame per 10 s", async () => {
    notifyStoriesUpdate({ scope: "own", userId: "author" });
    notifyStoriesUpdate({ scope: "own", userId: "author" });
    await settle();
    expect(frames("author")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames("author")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(frames("author")).toHaveLength(2);
  });

  it("every audience of a story: its servers, the friends and the author", async () => {
    notifyStoryAudiences("author", { serverIds: [SERVER], friends: true });
    await settle();
    expect(frames("friend")).toEqual([{ type: "stories-update", scope: "friends" }]);
    expect(frames("member")).toEqual([{ type: "stories-update", scope: "server", serverId: SERVER }]);
    expect(frames("author")).toHaveLength(2);
    expect(frames("author")).toEqual(
      expect.arrayContaining([
        { type: "stories-update", scope: "server", serverId: SERVER },
        { type: "stories-update", scope: "own" },
      ]),
    );
    expect(frames("stranger")).toEqual([]);
  });

  it("a frame from another instance reaches this instance's sockets", async () => {
    fake.handler!({ type: "stories-update", scope: "server", serverId: SERVER }, "other");
    fake.handler!({ type: "stories-update", scope: "friends", userIds: ["friend"] }, "other");
    fake.handler!({ type: "something-else" }, "other");
    await settle();
    expect(frames("member")).toEqual([{ type: "stories-update", scope: "server", serverId: SERVER }]);
    expect(frames("friend")).toEqual([{ type: "stories-update", scope: "friends" }]);
    expect(frames("stranger")).toEqual([]);
  });
});
