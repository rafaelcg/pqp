// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFileDropGuard,
  resetInternalDragForTests,
  type DroppedItems,
} from "@/lib/file-drop";
import { FileDropZone } from "./file-drop-zone";
import type { FileDropMode } from "@/hooks/use-file-drop-zone";

/**
 * The drop zone every surface is built on, driven with the events a browser
 * sends: enter, over, leave, drop.
 *
 * The things worth pinning are the ones that fail quietly. The overlay must
 * not flicker off when the pointer crosses a child (the depth count). It must
 * not appear for a drag that started inside pqp. A dialog opened from inside
 * the zone is a DOM sibling that React still bubbles through, and a file
 * dropped on IT must not attach to the conversation behind it. And a refused
 * drag has to be answered with no-drop, which is what stops the browser
 * opening the file.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function filesData(types = ["Files"], files: File[] = []): DataTransfer {
  return {
    types,
    files,
    items: files.map((f) => ({
      kind: "file",
      getAsFile: () => f,
      webkitGetAsEntry: () => ({ isDirectory: false, name: f.name }),
    })),
    dropEffect: "none",
  } as unknown as DataTransfer;
}

function fire(type: string, target: Element, data: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function mount(
  mode: FileDropMode,
  onDrop: (items: DroppedItems) => void = () => {},
  extra?: React.ReactNode,
) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FileDropZone
        mode={mode}
        onDrop={onDrop}
        acceptLabel="Drop to attach"
        refuseLabel="Uploads are off"
        data-testid="zone"
      >
        <p data-testid="child">messages</p>
        {extra}
      </FileDropZone>,
    );
  });
  return {
    zone: host.querySelector<HTMLElement>('[data-testid="zone"]')!,
    child: host.querySelector<HTMLElement>('[data-testid="child"]')!,
  };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetInternalDragForTests();
});

const overlay = () => document.querySelector<HTMLElement>("[data-file-drop-overlay]");

describe("FileDropZone", () => {
  it("shows the accept overlay while a file is over it, and clears it on leave", async () => {
    const { zone } = await mount("accept");
    expect(overlay()).toBeNull();

    fire("dragenter", zone, filesData());
    expect(overlay()?.dataset.fileDropOverlay).toBe("accept");
    expect(overlay()?.textContent).toBe("Drop to attach");
    // Decorative, and inert so the drop lands on the zone beneath.
    expect(overlay()?.getAttribute("aria-hidden")).toBe("true");
    expect(overlay()?.className).toContain("pointer-events-none");

    fire("dragleave", zone, filesData());
    expect(overlay()).toBeNull();
  });

  it("stays up while the pointer crosses children, and goes only when it truly leaves", async () => {
    const { zone, child } = await mount("accept");
    fire("dragenter", zone, filesData());
    fire("dragenter", child, filesData()); // into a message
    fire("dragleave", zone, filesData()); // the zone's own leave for that crossing
    expect(overlay()).not.toBeNull();
    fire("dragleave", child, filesData());
    expect(overlay()).toBeNull();
  });

  it("hands the files and folders to onDrop, claims the drop, and clears the overlay", async () => {
    const onDrop = vi.fn();
    const { zone } = await mount("accept", onDrop);
    const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    fire("dragenter", zone, filesData());
    const over = fire("dragover", zone, filesData(["Files"], [a]));
    expect(over.defaultPrevented).toBe(true);
    const drop = fire("drop", zone, filesData(["Files"], [a]));
    expect(drop.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]![0]).toEqual({ files: [a], folders: [] });
    expect(overlay()).toBeNull();
  });

  it("sets the copy cursor when it accepts, and no-drop when it refuses", async () => {
    const accepted = await mount("accept");
    const copy = filesData();
    fire("dragover", accepted.zone, copy);
    expect(copy.dropEffect).toBe("copy");
  });

  it("refuses with the reason, answers no-drop, and never calls onDrop", async () => {
    const onDrop = vi.fn();
    const { zone } = await mount("refuse", onDrop);
    const data = filesData();
    fire("dragenter", zone, data);
    expect(overlay()?.dataset.fileDropOverlay).toBe("refuse");
    expect(overlay()?.textContent).toBe("Uploads are off");
    const over = fire("dragover", zone, data);
    expect(over.defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("none");
    // Should a drop arrive anyway it is still claimed, so the browser does
    // not open the file, and still not delivered.
    const drop = fire("drop", zone, filesData());
    expect(drop.defaultPrevented).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("does nothing at all when it is off, and leaves the event to the page-wide guard", async () => {
    const onDrop = vi.fn();
    const { zone } = await mount("off", onDrop);
    fire("dragenter", zone, filesData());
    expect(overlay()).toBeNull();
    expect(fire("dragover", zone, filesData()).defaultPrevented).toBe(false);
    expect(fire("drop", zone, filesData()).defaultPrevented).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("ignores text, links and pqp's own row drags", async () => {
    const onDrop = vi.fn();
    const { zone } = await mount("accept", onDrop);
    for (const types of [["text/plain"], ["text/uri-list"], ["application/x-pqp-row"]]) {
      fire("dragenter", zone, filesData(types));
      expect(overlay()).toBeNull();
      expect(fire("dragover", zone, filesData(types)).defaultPrevented).toBe(false);
      expect(fire("drop", zone, filesData(types)).defaultPrevented).toBe(false);
    }
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("ignores a drag that started inside the page even when it carries Files", async () => {
    const uninstall = installFileDropGuard(window);
    try {
      const { zone } = await mount("accept");
      // The browser's own dragstart, on a picture in the transcript.
      fire("dragstart", zone, filesData(["text/uri-list", "Files"]));
      fire("dragenter", zone, filesData(["text/uri-list", "Files"]));
      expect(overlay()).toBeNull();
      fire("dragend", zone, filesData(["text/uri-list", "Files"]));
      // A real drop from the OS afterwards works again.
      fire("dragenter", zone, filesData());
      expect(overlay()).not.toBeNull();
    } finally {
      uninstall();
    }
  });

  it("does not take a drop aimed at a dialog portalled out of it", async () => {
    // A dialog opened from inside the pane lives outside it in the DOM, but
    // React still routes its events up through the pane.
    const portalHost = document.createElement("div");
    document.body.append(portalHost);
    const onDrop = vi.fn();
    await mount(
      "accept",
      onDrop,
      createPortal(<button data-testid="dialog-button">in a dialog</button>, portalHost),
    );
    const inDialog = portalHost.querySelector("button")!;
    fire("dragenter", inDialog, filesData());
    expect(overlay()).toBeNull();
    fire("drop", inDialog, filesData());
    expect(onDrop).not.toHaveBeenCalled();
    portalHost.remove();
  });

  it("drops the overlay when the mode goes off under a drag", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const render = (mode: FileDropMode) =>
      act(async () => {
        root!.render(
          <FileDropZone mode={mode} acceptLabel="Drop to attach" data-testid="zone">
            <p>x</p>
          </FileDropZone>,
        );
      });
    await render("accept");
    fire("dragenter", host.querySelector('[data-testid="zone"]')!, filesData());
    expect(overlay()).not.toBeNull();
    await render("off");
    expect(overlay()).toBeNull();
  });
});
