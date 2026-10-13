// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForumTag } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditTagsDialog } from "./forum-post-view";

/**
 * "Edit tags" opened as a title, a close and Cancel/Save around nothing when
 * the pane's tag list was empty (2026-10-12). It now says why, links managers
 * to the Tags settings, offers Try again when the read failed, and reads the
 * tags again as it opens.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TAGS: ForumTag[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Release", emoji: "🚀", moderated: false, position: 0, postCount: 0 },
  { id: "00000000-0000-4000-8000-000000000002", name: "Oficial", emoji: null, moderated: true, position: 1, postCount: 0 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(props: Partial<Parameters<typeof EditTagsDialog>[0]>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <EditTagsDialog
          open
          tags={[]}
          current={[]}
          isStaff={false}
          onClose={() => {}}
          onSave={() => {}}
          {...props}
        />
      </TooltipProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((one) =>
    one.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

describe("EditTagsDialog", () => {
  it("lists the tags a person can toggle, and no empty state", async () => {
    await mount({ tags: TAGS });
    expect(button("Release")).toBeDefined();
    expect(button("Oficial")).toBeUndefined();
    expect(document.querySelector("[data-forum-edit-tags-empty]")).toBeNull();
    expect(button("Save")?.disabled).toBe(false);
  });

  it("says there is nothing to pick instead of opening empty, and sends a manager to the settings", async () => {
    const onOpenSettings = vi.fn();
    const onClose = vi.fn();
    await mount({ tags: [], canManageTags: true, onOpenSettings, onClose });
    const empty = document.querySelector("[data-forum-edit-tags-empty]");
    expect(empty?.getAttribute("data-forum-edit-tags-empty")).toBe("none");
    expect(empty?.textContent).toContain("no tags to pick");
    // Nothing to save, so no Save at all.
    expect(button("Save")).toBeUndefined();
    await act(async () => button("Set up tags")!.click());
    expect(onClose).toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("holds Save, and says why, when the forum requires a tag and none is left", async () => {
    const onSave = vi.fn();
    await mount({ tags: TAGS, requireTag: true, current: [TAGS[0]!.id], onSave });
    expect(button("Save")?.disabled).toBe(false);
    // Untick the only tag.
    await act(async () => button("Release")!.click());
    expect(button("Save")?.disabled).toBe(true);
    expect(document.querySelector("[data-forum-edit-tags-required]")?.textContent).toContain(
      "Pick at least one tag.",
    );
    // A forum that does not require one saves an empty list.
  });

  it("offers no settings link to somebody who cannot manage the forum", async () => {
    await mount({ tags: [TAGS[1]!], canManageTags: false, onOpenSettings: () => {} });
    expect(document.querySelector("[data-forum-edit-tags-empty='none']")).not.toBeNull();
    expect(button("Set up tags")).toBeUndefined();
  });

  it("says the read failed, with Try again", async () => {
    const onRetry = vi.fn();
    await mount({ tags: [], tagsStatus: "error", onRetry });
    expect(document.querySelector("[data-forum-edit-tags-empty='error']")).not.toBeNull();
    await act(async () => button("Try again")!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("reads the tags again as it opens", async () => {
    const onRefresh = vi.fn();
    await mount({ tags: TAGS, onRefresh });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
