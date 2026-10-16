// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiscordMergePreview } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveCatalogue } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  previewDiscordMerge: vi.fn(),
  applyDiscordMerge: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, ...api };
});

const { DiscordImportMergeDialog } = await import("./discord-import-merge-dialog");
const { DiscordImportMergePreview, sumUntickedRules } = await import(
  "./discord-import-merge-preview"
);

function previewOf(overrides: Partial<DiscordMergePreview> = {}): DiscordMergePreview {
  return {
    templateUpdatedAt: null,
    isDirty: false,
    addedCategories: [{ templateId: 1, name: "Jogos" }],
    reusedCategories: [
      { templateId: 2, name: "Chat", existingName: "chat", existingId: "cat-chat" },
    ],
    addedChannels: [
      {
        templateId: 10,
        name: "lobby",
        type: "voice",
        topic: null,
        isPrivate: false,
        parentTemplateId: 1,
        parentExistingId: null,
        categoryName: "Jogos",
      },
      {
        templateId: 11,
        name: "staff",
        type: "text",
        topic: null,
        isPrivate: true,
        parentTemplateId: null,
        parentExistingId: "cat-chat",
        categoryName: "chat",
      },
    ],
    skipped: [
      { kind: "channel", name: "general", type: "text", categoryName: "chat", reason: "exists" },
      { kind: "channel", name: "extra", type: "text", categoryName: null, reason: "channelLimit" },
    ],
    addableRoles: [
      {
        templateId: 7,
        name: "Helpers",
        originalName: "Helpers",
        color: "#3498db",
        hoist: false,
        mentionable: false,
        permissions: "0",
        overwriteCount: 2,
      },
    ],
    reusedRoles: [],
    usage: { channels: { existing: 4, max: 200 }, categories: { existing: 1, max: 30 } },
    privateChannelNames: ["staff"],
    notInTemplate: ["members", "messages"],
    mappedAway: [],
    canCreateRoles: true,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  api.previewDiscordMerge.mockReset();
  api.applyDiscordMerge.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setActiveCatalogue(undefined);
});

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const text = () => document.body.textContent ?? "";

function click(element: Element | null) {
  expect(element, "element to click").not.toBeNull();
  act(() => {
    (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) ??
    null
  ) as HTMLButtonElement | null;
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("DiscordImportMergePreview", () => {
  it("says nothing is deleted, lists what is added, kept and left out, with cargos unticked", () => {
    const html = renderToStaticMarkup(
      <DiscordImportMergePreview
        preview={previewOf()}
        serverName="Casa"
        pickedRoles={new Set()}
        onToggleRole={() => {}}
      />,
    );
    expect(html).toContain("Everything already in Casa stays exactly as it is");
    expect(html).toContain("Jogos");
    expect(html).toContain("lobby");
    expect(html).toContain("staff");
    expect(html).toContain("Already here, kept as it is (1)");
    expect(html).toContain("did not fit under the channel limit");
    expect(html).toContain("Helpers");
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("2 channel rules that need a role you did not pick are left out.");
  });

  it("shows the empty state when there is nothing to add", () => {
    const html = renderToStaticMarkup(
      <DiscordImportMergePreview
        preview={previewOf({ addedCategories: [], addedChannels: [], addableRoles: [] })}
        serverName="Casa"
        pickedRoles={new Set()}
        onToggleRole={() => {}}
      />,
    );
    expect(html).toContain("There is nothing to add");
  });

  it("explains instead of offering cargos when the viewer cannot create them", () => {
    const html = renderToStaticMarkup(
      <DiscordImportMergePreview
        preview={previewOf({ canCreateRoles: false })}
        serverName="Casa"
        pickedRoles={new Set()}
        onToggleRole={() => {}}
      />,
    );
    expect(html).toContain("needs the Manage roles permission");
    expect(html).not.toContain('role="checkbox"');
  });

  it("counts only the rules of cargos left unticked", () => {
    const preview = previewOf();
    expect(sumUntickedRules(preview, new Set())).toBe(2);
    expect(sumUntickedRules(preview, new Set([7]))).toBe(0);
  });
});

describe("DiscordImportMergeDialog", () => {
  it("walks paste, preview, confirm, done, and sends no cargos by default", async () => {
    api.previewDiscordMerge.mockResolvedValue(previewOf());
    api.applyDiscordMerge.mockResolvedValue({
      plan: previewOf(),
      channels: [
        { id: "ch-1", name: "lobby", type: "voice", serverId: "srv-1" },
        { id: "ch-2", name: "staff", type: "text", serverId: "srv-1" },
      ],
      rolesCreated: [],
    });
    const onMerged = vi.fn();
    const onOpenChannel = vi.fn();
    const onClose = vi.fn();
    mount(
      <DiscordImportMergeDialog
        serverId="srv-1"
        serverName="Casa"
        onClose={onClose}
        onMerged={onMerged}
        onOpenChannel={onOpenChannel}
      />,
    );

    expect(text()).toContain("Nothing in Casa is deleted or changed");
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    type(textarea, "https://discord.new/abcd1234");
    click(button("Preview"));
    await flush();
    expect(api.previewDiscordMerge).toHaveBeenCalledWith("srv-1", "https://discord.new/abcd1234");
    expect(text()).toContain("This is what will be added");
    expect(text()).toContain("Nothing that is already here is deleted, renamed, moved or changed");

    click(button("Add to this community"));
    await flush();
    expect(api.applyDiscordMerge).toHaveBeenCalledWith("srv-1", "https://discord.new/abcd1234", []);
    expect(onMerged).toHaveBeenCalledWith("srv-1", expect.any(Array));
    expect(text()).toContain("Added: 2 channels, 1 category.");

    click(button("Go to the new channels"));
    expect(onOpenChannel).toHaveBeenCalledWith("srv-1", "ch-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("sends the template id of a cargo only after it is ticked", async () => {
    api.previewDiscordMerge.mockResolvedValue(previewOf());
    api.applyDiscordMerge.mockResolvedValue({ plan: previewOf(), channels: [], rolesCreated: ["Helpers"] });
    mount(<DiscordImportMergeDialog serverId="srv-1" serverName="Casa" onClose={() => {}} />);
    type(document.querySelector("textarea") as HTMLTextAreaElement, "abcd1234");
    click(button("Preview"));
    await flush();
    click(document.querySelector('[role="checkbox"]'));
    click(button("Add to this community"));
    await flush();
    expect(api.applyDiscordMerge).toHaveBeenCalledWith("srv-1", "abcd1234", [7]);
  });

  it("disables the confirm button when everything is already there", async () => {
    api.previewDiscordMerge.mockResolvedValue(
      previewOf({ addedCategories: [], addedChannels: [], addableRoles: [] }),
    );
    mount(<DiscordImportMergeDialog serverId="srv-1" serverName="Casa" onClose={() => {}} />);
    type(document.querySelector("textarea") as HTMLTextAreaElement, "abcd1234");
    click(button("Preview"));
    await flush();
    expect(text()).toContain("Nothing new to add");
    expect(button("Add to this community")?.disabled).toBe(true);
  });

  it("says plainly when the server refuses (403) and when the door is closed (404)", async () => {
    const { ApiError } = await import("@/lib/api");
    api.previewDiscordMerge.mockRejectedValueOnce(new ApiError(403, "no"));
    mount(<DiscordImportMergeDialog serverId="srv-1" serverName="Casa" onClose={() => {}} />);
    type(document.querySelector("textarea") as HTMLTextAreaElement, "abcd1234");
    click(button("Preview"));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Manage server permission",
    );

    api.previewDiscordMerge.mockRejectedValueOnce(new ApiError(404, "Not found"));
    click(button("Preview"));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "can't import a layout right now",
    );
  });
});
