// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DroppedItems } from "@/lib/file-drop";

/**
 * What the composer does with a drop its pane hands it.
 *
 * Every conversation surface (a text channel, a voice channel's chat, a DM, a
 * thread) feeds this same composer, so this is the one place the per-file
 * behaviour is pinned: a good file starts an upload and gets its own chip, a
 * bad one says why in the shared error strip, a folder is named rather than
 * swallowed, and the per-message cap holds however many arrive at once.
 */

const uploadSpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments")>();
  return {
    ...actual,
    loadAttachmentConfig: () =>
      Promise.resolve({ enabled: true, maxBytes: 10 * 1024 * 1024 }),
    createPreviewUrl: () => "blob:preview",
    revokePreviewUrl: () => {},
    // Never settles: the chip stays in "uploading", which is the state the
    // per-file progress UI is in for the whole of a real upload.
    uploadAttachment: (...args: unknown[]) => {
      uploadSpy(...args);
      return new Promise(() => {});
    },
  };
});

import { MessageComposer } from "./message-composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const CHANNEL = "11111111-1111-4111-8111-111111111111";

function file(name: string, type = "image/png", size = 3): File {
  const f = new File([new Uint8Array([1, 2, 3])], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function renderComposer(droppedItems: DroppedItems | null) {
  const consumed = vi.fn();
  const tree = (items: DroppedItems | null) => (
    <TooltipProvider>
      <MessageComposer
        onSend={() => {}}
        channelId={CHANNEL}
        droppedItems={items}
        onDroppedItemsConsumed={consumed}
      />
    </TooltipProvider>
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(tree(null));
  });
  // The attachment config is fetched in an effect; let it land.
  await act(async () => {});
  await act(async () => {
    root!.render(tree(droppedItems));
  });
  return { consumed };
}

const chips = () =>
  [...document.querySelectorAll('ul[aria-label="Attachments to send"] li')].map(
    (li) => li.textContent ?? "",
  );
const strip = () =>
  document.querySelector<HTMLElement>('[role="status"]')?.textContent ?? "";

beforeEach(() => {
  uploadSpy.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("a drop reaching the composer", () => {
  it("starts an upload and a chip for each good file, and says it has taken the drop", async () => {
    const { consumed } = await renderComposer({
      files: [file("a.png"), file("b.png")],
      folders: [],
    });
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(chips()).toHaveLength(2);
    expect(chips()[0]).toContain("a.png");
    expect(consumed).toHaveBeenCalled();
    expect(strip()).toBe("");
  });

  it("names a dropped folder instead of swallowing it", async () => {
    await renderComposer({ files: [], folders: ["Holiday"] });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(chips()).toHaveLength(0);
    expect(strip()).toContain("Holiday is a folder");
    expect(strip()).toContain("Drop the files inside it");
  });

  it("counts several folders", async () => {
    await renderComposer({ files: [], folders: ["A", "B", "C"] });
    expect(strip()).toContain("3 folders were skipped");
  });

  it("takes the files of a mixed drop and still names the folder", async () => {
    await renderComposer({ files: [file("kept.png")], folders: ["Skipped"] });
    expect(chips()).toHaveLength(1);
    expect(strip()).toContain("Skipped is a folder");
  });

  it("says why for a file that is too big or the wrong type, and uploads neither", async () => {
    await renderComposer({
      files: [
        file("huge.png", "image/png", 11 * 1024 * 1024),
        file("setup.exe", "application/x-msdownload"),
      ],
      folders: [],
    });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(strip()).toContain("huge.png: larger than the");
    expect(strip()).toContain("setup.exe: application/x-msdownload files are not allowed");
  });

  it("holds the per-message cap however many arrive at once", async () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`p${i}.png`));
    await renderComposer({ files: many, folders: [] });
    expect(uploadSpy).toHaveBeenCalledTimes(10);
    expect(chips()).toHaveLength(10);
    expect(strip()).toContain("only 10 attachments per message");
  });
});
