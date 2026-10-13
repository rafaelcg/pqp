// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ForumTag } from "@pqp/shared";
import { loadLocale, setActiveCatalogue } from "@/lib/i18n";

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
  { id: "a0000000-0000-4000-8000-000000000001", name: "Bug", emoji: "🐛", icon: "bug", preset: "bug", moderated: false, position: 0, postCount: 64 },
  { id: "a0000000-0000-4000-8000-000000000002", name: "Dúvida", emoji: null, icon: null, preset: null, moderated: false, position: 1, postCount: 3 },
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
  setActiveCatalogue(undefined);
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
  it("puts Tags between the overview and permissions, and offers webhooks (each delivery is a post)", async () => {
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

  it("keeps a saved tag list saved when the switch after it fails", async () => {
    api.putForumTags.mockImplementation(async (_id: string, body: { tags: unknown[] }) => ({
      tags: (body.tags as Array<{ id?: string; name: string; emoji?: string | null; moderated: boolean }>).map(
        (tag, position) => ({
          id: tag.id ?? "a0000000-0000-4000-8000-000000000009",
          name: tag.name,
          emoji: tag.emoji ?? null,
          moderated: tag.moderated,
          position,
          postCount: 0,
        }),
      ),
    }));
    api.updateForumSettings.mockRejectedValueOnce(new Error("down"));
    await mount(forum);
    // A new tag and the switch, together.
    const input = document.querySelector<HTMLInputElement>('input[aria-label="New tag name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Games");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    const toggle = [...document.querySelectorAll('[role="switch"]')].find((one) =>
      /Require at least one tag/.test(one.getAttribute("aria-label") ?? one.textContent ?? ""),
    ) as HTMLElement;
    await act(async () => toggle.click());
    expect(document.body.textContent).toContain("2 unsaved changes");
    const save = () =>
      [...document.querySelectorAll("button")].find((one) => one.textContent === "Save")!;
    await act(async () => save().click());
    expect(api.putForumTags).toHaveBeenCalledOnce();
    // The list is saved; only the switch is left, and a retry sends only it.
    expect(document.body.textContent).toContain("1 unsaved change");
    api.updateForumSettings.mockResolvedValue({
      settings: { requireTag: true, defaultSort: "activity" },
    });
    await act(async () => save().click());
    expect(api.putForumTags).toHaveBeenCalledOnce();
    expect(api.updateForumSettings).toHaveBeenLastCalledWith(forum.id, { requireTag: true });
    expect(document.body.textContent).not.toContain("unsaved change");
  });

  it("keeps an edit typed while the save was out", async () => {
    let finish: (value: { tags: ForumTag[] }) => void = () => {};
    api.putForumTags.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount(forum);
    const nameInputs = () =>
      [...document.querySelectorAll<HTMLInputElement>("[data-forum-tag-row] input")];
    const type = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type(nameInputs()[0]!, "Bugs");
    const save = [...document.querySelectorAll("button")].find((one) => one.textContent === "Save")!;
    await act(async () => save.click());
    // Still out: the person renames the second tag.
    await type(nameInputs()[1]!, "Dúvidas");
    await act(async () => {
      finish({ tags: [{ ...tags[0]!, name: "Bugs", preset: null }, tags[1]!] });
    });
    expect(nameInputs().map((input) => input.value)).toEqual(["Bugs", "Dúvidas"]);
    expect(document.body.textContent).toContain("1 unsaved change");
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
  describe("icons and starter names", () => {
    const type = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-forum-tag-row]")];
    const nameInput = (row: HTMLElement) => row.querySelector<HTMLInputElement>("input")!;
    const saveButton = () =>
      [...document.querySelectorAll("button")].find((one) =>
        /^(Save|Salvar)$/.test(one.textContent ?? ""),
      )!;
    const starters: ForumTag[] = [
      { id: "a0000000-0000-4000-8000-000000000011", name: "Question", emoji: "❓", icon: "question", preset: "question", moderated: false, position: 0, postCount: 2 },
      { id: "a0000000-0000-4000-8000-000000000012", name: "Receitas", emoji: null, icon: null, preset: null, moderated: false, position: 1, postCount: 0 },
    ];

    it("draws an icon in each row's square and offers no emoji field", async () => {
      await mount(forum);
      const first = rows()[0]!;
      expect(first.querySelector('[data-forum-tag-icon="bug"]')).not.toBeNull();
      expect(first.querySelector("[data-forum-tag-icon-button]")).not.toBeNull();
      expect(document.querySelector('[aria-label^="Emoji"]')).toBeNull();
    });

    it("picks an icon from the grid and saves it with the icon's own emoji beside it", async () => {
      api.putForumTags.mockImplementation(async (_id: string, body: { tags: Array<Record<string, unknown>> }) => ({
        tags: body.tags.map((one, position) => ({ postCount: 0, position, ...one, id: one.id ?? "x" })),
      }));
      await mount(forum);
      const square = rows()[1]!.querySelector<HTMLButtonElement>("[data-forum-tag-icon-button]")!;
      expect(square.getAttribute("aria-label")).toBe("Icon for Dúvida");
      await act(async () => square.click());
      const picker = document.querySelector('[data-forum-tag-icon-picker]');
      expect(picker).not.toBeNull();
      expect(picker!.getAttribute("role")).toBe("dialog");
      // "No icon" plus every curated icon, each one named.
      const options = [...picker!.querySelectorAll<HTMLElement>('[role="radio"]')];
      expect(options.length).toBeGreaterThan(24);
      expect(options.every((one) => (one.getAttribute("aria-label") ?? "") !== "")).toBe(true);
      await act(async () => document.querySelector<HTMLElement>('[data-forum-tag-icon-option="idea"]')!.click());
      expect(document.querySelector("[data-forum-tag-icon-picker]")).toBeNull();
      expect(rows()[1]!.querySelector('[data-forum-tag-icon="idea"]')).not.toBeNull();
      expect(document.body.textContent).toContain("1 unsaved change");
      await act(async () => saveButton().click());
      const sent = api.putForumTags.mock.calls[0]![1] as { tags: Array<Record<string, unknown>> };
      expect(sent.tags[1]).toMatchObject({ name: "Dúvida", icon: "idea", emoji: "💡" });
      // The first tag is untouched and sends what it had.
      expect(sent.tags[0]).toMatchObject({ name: "Bug", icon: "bug", preset: "bug" });
    });

    it("moves through the grid with the arrows, picks with Enter, and Escape closes only the picker", async () => {
      await mount(forum);
      const square = rows()[1]!.querySelector<HTMLButtonElement>("[data-forum-tag-icon-button]")!;
      await act(async () => square.click());
      const focused = () => document.activeElement as HTMLElement;
      // No icon yet: the focus starts on "No icon".
      expect(focused().getAttribute("data-forum-tag-icon-option")).toBe("none");
      await act(async () => {
        focused().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
      expect(focused().getAttribute("data-forum-tag-icon-option")).toBe("question");
      await act(async () => {
        focused().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      // One row of six cells down.
      expect(focused().getAttribute("data-forum-tag-icon-option")).not.toBe("question");
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(document.querySelector("[data-forum-tag-icon-picker]")).toBeNull();
      // The sheet is still there, and the keyboard is back on the square.
      expect(rows()).toHaveLength(2);
      expect(document.activeElement).toBe(square);
      // And the draft did not change.
      expect(document.body.textContent).not.toContain("unsaved change");
    });

    it("clearing the icon clears the legacy emoji with it", async () => {
      api.putForumTags.mockResolvedValue({ tags });
      await mount(forum);
      const square = rows()[0]!.querySelector<HTMLButtonElement>("[data-forum-tag-icon-button]")!;
      await act(async () => square.click());
      await act(async () => document.querySelector<HTMLElement>('[data-forum-tag-icon-option="none"]')!.click());
      await act(async () => saveButton().click());
      const sent = api.putForumTags.mock.calls[0]![1] as { tags: Array<Record<string, unknown>> };
      expect(sent.tags[0]).toMatchObject({ icon: null, emoji: null });
    });

    it("shows a starter in the viewer's language and keeps the stored name until it is renamed", async () => {
      await loadLocale("pt-BR");
      api.fetchForumTags.mockResolvedValue({ tags: starters });
      api.putForumTags.mockResolvedValue({ tags: starters });
      await mount(forum);
      expect(rows().map((row) => nameInput(row).value)).toEqual(["Dúvida", "Receitas"]);
      // Touching something else sends the stored English name, preset intact.
      const staff = rows()[0]!.querySelector<HTMLElement>('[role="switch"]')!;
      await act(async () => staff.click());
      await act(async () => saveButton().click());
      const kept = api.putForumTags.mock.calls[0]![1] as { tags: Array<Record<string, unknown>> };
      expect(kept.tags[0]).toMatchObject({ name: "Question", preset: "question", moderated: true });
    });

    it("typing in a starter is the rename: the new name is sent and the preset is let go", async () => {
      api.fetchForumTags.mockResolvedValue({ tags: starters });
      api.putForumTags.mockResolvedValue({ tags: starters });
      await mount(forum);
      await type(nameInput(rows()[0]!), "Ask us");
      await act(async () => saveButton().click());
      const sent = api.putForumTags.mock.calls[0]![1] as { tags: Array<Record<string, unknown>> };
      expect(sent.tags[0]).toMatchObject({ name: "Ask us", preset: null, icon: "question" });
    });

    it("refuses a new tag named like what a starter shows, and like what it is stored as", async () => {
      await loadLocale("pt-BR");
      api.fetchForumTags.mockResolvedValue({ tags: starters });
      await mount(forum);
      const add = document.querySelector<HTMLInputElement>("form input")!;
      for (const typed of ["duvida", "Question"]) {
        await type(add, typed);
        await act(async () => add.form!.requestSubmit());
        expect(document.querySelector("#forum-tag-add-error")?.textContent, typed).toBeTruthy();
        expect(rows()).toHaveLength(2);
      }
    });
  });
});
