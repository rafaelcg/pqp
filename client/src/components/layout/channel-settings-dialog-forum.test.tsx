// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ForumTag } from "@pqp/shared";

const api = vi.hoisted(() => ({
  fetchChannelMembers: vi.fn(),
  fetchChannelOverwrites: vi.fn(),
  fetchMembers: vi.fn(),
  fetchForumTags: vi.fn(),
  fetchForumSettings: vi.fn(),
  putForumTags: vi.fn(),
  updateForumSettings: vi.fn(),
  updateChannel: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

const { ChannelSettingsDialog } = await import("./channel-settings-dialog");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const forum: Channel = {
  id: "f0000000-0000-4000-8000-000000000000",
  serverId: "s0000000-0000-4000-8000-000000000000",
  kind: "server",
  name: "ajuda",
  type: "forum",
  position: 0,
  parentId: null,
  isPrivate: false,
  topic: "Um problema por post.",
  imageUrl: null,
  slowmodeSeconds: 0,
  voiceTransport: null,
};

const tags: ForumTag[] = [
  { id: "a0000000-0000-4000-8000-000000000001", name: "Bug", emoji: "🐛", moderated: false, position: 0, postCount: 64 },
  { id: "a0000000-0000-4000-8000-000000000002", name: "Dúvida", emoji: null, moderated: false, position: 1, postCount: 3 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  for (const fn of Object.values(api)) {
    fn.mockReset();
  }
  api.fetchChannelMembers.mockResolvedValue({ members: [] });
  api.fetchChannelOverwrites.mockResolvedValue({ overwrites: [] });
  api.fetchMembers.mockResolvedValue({ members: [] });
  api.fetchForumTags.mockResolvedValue({ tags });
  api.fetchForumSettings.mockResolvedValue({
    settings: { requireTag: false, defaultSort: "activity" },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(channel: Channel, canManageChannels = true) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <ChannelSettingsDialog
          open
          channel={channel}
          requestedSection="tags"
          forceAdvanced={false}
          serverId={channel.serverId}
          roles={[]}
          canManageChannels={canManageChannels}
          canManageRoles={false}
          onClose={() => undefined}
          onChannelUpdated={() => undefined}
        />
      </TooltipProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const tabNames = () =>
  [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());

describe("ChannelSettingsDialog on a forum", () => {
  it("puts Tags between the overview and permissions, and keeps webhooks", async () => {
    await mount(forum);
    expect(tabNames()).toEqual(["Overview", "Tags", "Permissions", "Webhooks"]);
  });

  it("has no Tags section for a text channel, which still keeps its webhooks", async () => {
    await mount({ ...forum, type: "text" });
    expect(tabNames()).toEqual(["Overview", "Permissions", "Webhooks"]);
    expect(api.fetchForumTags).not.toHaveBeenCalled();
  });

  it("shows no Tags or webhooks to somebody without Manage channels", async () => {
    await mount(forum, false);
    expect(tabNames()).not.toContain("Tags");
    expect(tabNames()).not.toContain("Webhooks");
  });

  it("saves only the switch with one PATCH when no tag changed", async () => {
    api.updateForumSettings.mockResolvedValue({
      settings: { requireTag: true, defaultSort: "activity" },
    });
    await mount(forum);
    const toggle = [...document.querySelectorAll('[role="switch"]')].find((one) =>
      /Require at least one tag/.test(one.getAttribute("aria-label") ?? one.textContent ?? ""),
    ) as HTMLElement;
    await act(async () => toggle.click());
    expect(document.body.textContent).toContain("1 unsaved change");
    const save = [...document.querySelectorAll("button")].find(
      (one) => one.textContent === "Save",
    )!;
    await act(async () => save.click());
    expect(api.putForumTags).not.toHaveBeenCalled();
    expect(api.updateForumSettings).toHaveBeenCalledWith(forum.id, { requireTag: true });
    expect(document.body.textContent).not.toContain("unsaved change");
  });

  it("says the tags could not load and offers a retry, without breaking the sheet", async () => {
    api.fetchForumTags.mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));
    await mount(forum);
    expect(document.body.textContent).toContain("Couldn't load this forum's tags.");
    api.fetchForumTags.mockResolvedValue({ tags });
    const retry = [...document.querySelectorAll("button")].find(
      (one) => one.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelectorAll("[data-forum-tag-row]")).toHaveLength(2);
  });
});
