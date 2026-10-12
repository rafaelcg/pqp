// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForumSettings, ForumTag } from "@pqp/shared";

/**
 * The pane's tags, in the shape the server answers (the four starter tags of
 * `forum-teste` on 2026-10-12, where a composer that required a tag showed no
 * picker and the Edit tags dialog opened empty). Every case here is a way the
 * pane's list used to end up empty, or stay empty, while the forum had tags.
 */

const fetchForumTagsMock = vi.hoisted(() => vi.fn());
const fetchForumSettingsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/forum-api", () => ({
  fetchForumTags: (...args: unknown[]) => fetchForumTagsMock(...args),
  fetchForumSettings: (...args: unknown[]) => fetchForumSettingsMock(...args),
}));

const { TAGS_READ_ATTEMPTS, TAGS_RETRY_MS, useForumRules } = await import("./use-forum-rules");
const { dispatchForumFrame, dispatchForumReconnected } = await import("@/lib/forum-frames");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FORUM_ID = "09b106a8-c9e8-4c6b-9b26-9e9e164ce389";

function tag(position: number, name: string, emoji: string, moderated = false): ForumTag {
  return {
    id: `00000000-0000-4000-8000-00000000000${position + 1}`,
    name,
    emoji,
    moderated,
    position,
    postCount: 0,
  };
}
const STARTER: ForumTag[] = [
  tag(0, "Release", "🚀"),
  tag(1, "WIP", "🛠️"),
  tag(2, "Discussion", "💬"),
  tag(3, "Question", "❓"),
];
const REQUIRE: ForumSettings = { requireTag: true, defaultSort: "activity" };

let root: Root | null = null;
let host: HTMLElement | null = null;
let latest: ReturnType<typeof useForumRules>;

function Probe({ forumId }: { forumId: string }) {
  latest = useForumRules(forumId);
  return null;
}

async function mount(forumId = FORUM_ID) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Probe forumId={forumId} />));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchForumTagsMock.mockReset();
  fetchForumSettingsMock.mockReset();
  fetchForumSettingsMock.mockResolvedValue({ settings: REQUIRE });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("useForumRules", () => {
  it("holds the forum's tags and settings once both reads answer", async () => {
    fetchForumTagsMock.mockResolvedValue({ tags: STARTER });
    await mount();
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.tags.map((one) => one.name)).toEqual([
      "Release",
      "WIP",
      "Discussion",
      "Question",
    ]);
    expect(latest.settings).toEqual(REQUIRE);
  });

  it("follows a tags frame, and a settings-only frame leaves the tags alone", async () => {
    // The tab opened before the tags existed: an empty, answered list.
    fetchForumTagsMock.mockResolvedValue({ tags: [] });
    await mount();
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.tags).toEqual([]);

    act(() =>
      dispatchForumFrame({ type: "forum-config-update", forumId: FORUM_ID, tags: STARTER }),
    );
    expect(latest.tags).toHaveLength(4);

    // Then "require a tag" is switched on: the frame carries only the switch.
    act(() =>
      dispatchForumFrame({ type: "forum-config-update", forumId: FORUM_ID, settings: REQUIRE }),
    );
    expect(latest.settings).toEqual(REQUIRE);
    expect(latest.tags).toHaveLength(4);
  });

  it("ignores another forum's frame", async () => {
    fetchForumTagsMock.mockResolvedValue({ tags: [] });
    await mount();
    await flush();
    act(() =>
      dispatchForumFrame({
        type: "forum-config-update",
        forumId: "11111111-1111-4111-8111-111111111111",
        tags: STARTER,
      }),
    );
    expect(latest.tags).toEqual([]);
  });

  it("does not let a read that started before a frame put the list back", async () => {
    let answer: (value: { tags: ForumTag[] }) => void = () => {};
    fetchForumTagsMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await mount();
    act(() =>
      dispatchForumFrame({ type: "forum-config-update", forumId: FORUM_ID, tags: STARTER }),
    );
    expect(latest.tags).toHaveLength(4);
    // The read that was already on the wire answers with the older, empty list.
    await act(async () => answer({ tags: [] }));
    expect(latest.tags).toHaveLength(4);
  });

  it("retries a failed read instead of keeping an empty list", async () => {
    vi.useFakeTimers();
    fetchForumTagsMock
      .mockRejectedValueOnce(new Error("429"))
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue({ tags: STARTER });
    await mount();
    await flush();
    expect(latest.status).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAGS_RETRY_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAGS_RETRY_MS * 2);
    });
    expect(fetchForumTagsMock).toHaveBeenCalledTimes(3);
    expect(latest.status).toBe("ready");
    expect(latest.tags).toHaveLength(4);
  });

  it("says error, not empty, when every try fails, and Try again recovers", async () => {
    vi.useFakeTimers();
    fetchForumTagsMock.mockRejectedValue(new Error("offline"));
    await mount();
    await flush();
    for (let attempt = 1; attempt < TAGS_READ_ATTEMPTS; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TAGS_RETRY_MS * 2 ** (attempt - 1));
      });
    }
    expect(fetchForumTagsMock).toHaveBeenCalledTimes(TAGS_READ_ATTEMPTS);
    expect(latest.status).toBe("error");
    expect(latest.tags).toEqual([]);

    fetchForumTagsMock.mockResolvedValue({ tags: STARTER });
    await act(async () => latest.retryTags());
    await flush();
    expect(latest.status).toBe("ready");
    expect(latest.tags).toHaveLength(4);
  });

  it("reads again when asked, and when the socket comes back", async () => {
    fetchForumTagsMock.mockResolvedValue({ tags: [] });
    await mount();
    await flush();
    expect(latest.tags).toEqual([]);

    // Saved while nobody was listening (an older bundle, a dropped socket).
    fetchForumTagsMock.mockResolvedValue({ tags: STARTER });
    await act(async () => latest.refresh());
    await flush();
    expect(latest.tags).toHaveLength(4);

    fetchForumTagsMock.mockResolvedValue({ tags: [STARTER[0]!] });
    await act(async () => dispatchForumReconnected());
    await flush();
    expect(latest.tags).toHaveLength(1);
  });

  it("keeps the last good list when a refresh fails", async () => {
    vi.useFakeTimers();
    fetchForumTagsMock.mockResolvedValue({ tags: STARTER });
    await mount();
    await flush();
    fetchForumTagsMock.mockRejectedValue(new Error("offline"));
    await act(async () => latest.refresh());
    for (let attempt = 1; attempt <= TAGS_READ_ATTEMPTS; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TAGS_RETRY_MS * 2 ** attempt);
      });
    }
    expect(latest.status).toBe("ready");
    expect(latest.tags).toHaveLength(4);
  });

  it("does not let an older settings read overwrite a settings frame or another forum's rules", async () => {
    let answerOld: (value: { settings: ForumSettings }) => void = () => {};
    fetchForumTagsMock.mockResolvedValue({ tags: [] });
    fetchForumSettingsMock.mockReturnValue(
      new Promise((resolve) => {
        answerOld = resolve;
      }),
    );
    await mount();
    await flush();
    act(() =>
      dispatchForumFrame({
        type: "forum-config-update",
        forumId: FORUM_ID,
        settings: { requireTag: true, defaultSort: "created" },
      }),
    );
    await act(async () => answerOld({ settings: { requireTag: false, defaultSort: "activity" } }));
    expect(latest.settings).toEqual({ requireTag: true, defaultSort: "created" });

    // A read for the first forum that lands after the switch is dropped too.
    let answerFirst: (value: { settings: ForumSettings }) => void = () => {};
    fetchForumSettingsMock.mockReturnValueOnce(
      new Promise((resolve) => {
        answerFirst = resolve;
      }),
    );
    await act(async () => latest.refresh());
    fetchForumSettingsMock.mockResolvedValue({ settings: { requireTag: false, defaultSort: "hot" } });
    await act(async () =>
      root!.render(<Probe forumId="11111111-1111-4111-8111-111111111111" />),
    );
    await flush();
    await act(async () => answerFirst({ settings: { requireTag: true, defaultSort: "created" } }));
    expect(latest.settings).toEqual({ requireTag: false, defaultSort: "hot" });
  });

  it("stops retrying when the pane goes away", async () => {
    vi.useFakeTimers();
    fetchForumTagsMock.mockRejectedValue(new Error("offline"));
    await mount();
    await flush();
    expect(fetchForumTagsMock).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;
    await vi.advanceTimersByTimeAsync(TAGS_RETRY_MS * 10);
    expect(fetchForumTagsMock).toHaveBeenCalledTimes(1);
  });

  it("starts over for another forum", async () => {
    fetchForumTagsMock.mockResolvedValue({ tags: STARTER });
    await mount();
    await flush();
    fetchForumTagsMock.mockResolvedValue({ tags: [] });
    await act(async () =>
      root!.render(<Probe forumId="11111111-1111-4111-8111-111111111111" />),
    );
    await flush();
    expect(latest.tags).toEqual([]);
    expect(fetchForumTagsMock).toHaveBeenLastCalledWith("11111111-1111-4111-8111-111111111111");
  });
});
