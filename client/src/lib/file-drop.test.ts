// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filesFromDataTransfer,
  firstDroppedFile,
  installFileDropGuard,
  isExternalFileDrag,
  isFileDrag,
  isInternalDrag,
  readDroppedItems,
  resetInternalDragForTests,
} from "./file-drop";

/**
 * What counts as a file drop, and what the page does about the ones nobody
 * claims.
 *
 * `DataTransfer` does not exist in jsdom, and a real one cannot be told to
 * report a directory anyway, so these are the fakes the browser's own shape
 * implies: `types`, `files`, and `items` whose entries answer
 * `webkitGetAsEntry()`. The real thing (a Finder folder arriving through
 * `Input.dispatchDragEvent`, a real entry that says `isDirectory`) is driven
 * end to end in `e2e/file-drop.spec.ts`.
 */

function file(name: string, type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

interface FakeItem {
  kind: "file" | "string";
  file?: File;
  directory?: string;
  noEntry?: boolean;
}

function transfer(options: {
  types?: string[];
  files?: File[];
  items?: FakeItem[];
}): DataTransfer {
  const items = (options.items ?? []).map((item) => ({
    kind: item.kind,
    getAsFile: () => item.file ?? null,
    ...(item.noEntry
      ? {}
      : {
          webkitGetAsEntry: () =>
            item.directory
              ? { isDirectory: true, name: item.directory }
              : { isDirectory: false, name: item.file?.name ?? "" },
        }),
  }));
  return {
    types: options.types ?? ["Files"],
    files: options.files ?? [],
    items,
  } as unknown as DataTransfer;
}

describe("isFileDrag", () => {
  it("is true only when the drag carries Files", () => {
    expect(isFileDrag(transfer({ types: ["Files"] }))).toBe(true);
    expect(isFileDrag(transfer({ types: ["text/uri-list", "Files"] }))).toBe(true);
  });

  it("ignores text, links, pqp's own row drags, and nothing at all", () => {
    expect(isFileDrag(transfer({ types: ["text/plain"] }))).toBe(false);
    expect(isFileDrag(transfer({ types: ["text/uri-list", "text/html"] }))).toBe(false);
    // The channel list and the voice roster set custom types on dragstart.
    expect(isFileDrag(transfer({ types: ["application/x-pqp-channel", "text/plain"] }))).toBe(false);
    expect(isFileDrag(transfer({ types: [] }))).toBe(false);
    expect(isFileDrag(null)).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});

describe("readDroppedItems", () => {
  it("returns the files of an ordinary drop, many at once", () => {
    const a = file("a.png");
    const b = file("b.png");
    expect(
      readDroppedItems(
        transfer({
          files: [a, b],
          items: [
            { kind: "file", file: a },
            { kind: "file", file: b },
          ],
        }),
      ),
    ).toEqual({ files: [a, b], folders: [] });
  });

  it("tells a dropped folder from a file, and does not hand the folder on as one", () => {
    // Chromium lists the folder in `files` too, as a typeless, empty "file".
    const placeholder = file("Holiday", "");
    expect(
      readDroppedItems(
        transfer({
          files: [placeholder],
          items: [{ kind: "file", file: placeholder, directory: "Holiday" }],
        }),
      ),
    ).toEqual({ files: [], folders: ["Holiday"] });
  });

  it("keeps the files and names the folders when a drop is both", () => {
    const real = file("kept.png");
    const placeholder = file("Folder", "");
    const result = readDroppedItems(
      transfer({
        files: [real, placeholder],
        items: [
          { kind: "file", file: real },
          { kind: "file", file: placeholder, directory: "Folder" },
        ],
      }),
    );
    expect(result.files).toEqual([real]);
    expect(result.folders).toEqual(["Folder"]);
  });

  it("falls back to the items when `files` is empty (a paste)", () => {
    const shot = file("image.png");
    expect(
      readDroppedItems(
        transfer({
          types: ["text/html", "Files"],
          files: [],
          items: [
            { kind: "string" },
            { kind: "file", file: shot, noEntry: true },
          ],
        }),
      ),
    ).toEqual({ files: [shot], folders: [] });
  });

  it("finds nothing in a text or link drag", () => {
    expect(
      readDroppedItems(
        transfer({
          types: ["text/plain"],
          items: [{ kind: "string" }],
        }),
      ),
    ).toEqual({ files: [], folders: [] });
    expect(readDroppedItems(null)).toEqual({ files: [], folders: [] });
  });

  it("survives an engine whose entry lookup throws", () => {
    const f = file("a.png");
    const data = {
      types: ["Files"],
      files: [f],
      items: [
        {
          kind: "file",
          getAsFile: () => f,
          webkitGetAsEntry: () => {
            throw new Error("denied");
          },
        },
      ],
    } as unknown as DataTransfer;
    expect(readDroppedItems(data)).toEqual({ files: [f], folders: [] });
  });
});

describe("filesFromDataTransfer", () => {
  it("is the files of the drop and never a folder", () => {
    const real = file("x.png");
    const placeholder = file("Dir", "");
    expect(
      filesFromDataTransfer(
        transfer({
          files: [real, placeholder],
          items: [
            { kind: "file", file: real },
            { kind: "file", file: placeholder, directory: "Dir" },
          ],
        }),
      ),
    ).toEqual([real]);
    expect(filesFromDataTransfer(undefined)).toEqual([]);
  });
});

describe("firstDroppedFile", () => {
  it("takes the first file and ignores the rest", () => {
    const a = file("a.png");
    expect(firstDroppedFile({ files: [a, file("b.png")], folders: ["F"] })).toEqual({
      file: a,
      folder: null,
    });
  });

  it("names a folder only when there is no file to use", () => {
    expect(firstDroppedFile({ files: [], folders: ["Photos"] })).toEqual({
      file: null,
      folder: "Photos",
    });
    expect(firstDroppedFile({ files: [], folders: [] })).toEqual({
      file: null,
      folder: null,
    });
  });
});

/** An event the way a browser would build it, with a `dataTransfer` we control. */
function dragEvent(
  type: string,
  data: DataTransfer,
  target: EventTarget = document.body,
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: data });
  target.dispatchEvent(event);
  return event;
}

describe("installFileDropGuard", () => {
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installFileDropGuard(window);
  });
  afterEach(() => {
    uninstall();
    resetInternalDragForTests();
  });

  it("answers an unclaimed file drag with no-drop, so no drop is delivered", () => {
    const data = { ...transfer({}), dropEffect: "copy" } as unknown as DataTransfer;
    const over = dragEvent("dragover", data);
    expect(over.defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("none");
  });

  it("cancels a file drop that arrives anyway, so the browser never opens it", () => {
    expect(dragEvent("drop", transfer({})).defaultPrevented).toBe(true);
  });

  it("leaves a drag a zone has already claimed exactly as the zone set it", () => {
    const data = { ...transfer({}), dropEffect: "copy" } as unknown as DataTransfer;
    const zone = document.createElement("div");
    document.body.append(zone);
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    dragEvent("dragover", data, zone);
    expect(data.dropEffect).toBe("copy");
    zone.remove();
  });

  it("does not touch text, links or pqp's own drags", () => {
    for (const types of [["text/plain"], ["text/uri-list"], ["application/x-pqp-row"]]) {
      const data = { ...transfer({ types }), dropEffect: "move" } as unknown as DataTransfer;
      expect(dragEvent("dragover", data).defaultPrevented).toBe(false);
      expect(data.dropEffect).toBe("move");
      expect(dragEvent("drop", transfer({ types })).defaultPrevented).toBe(false);
    }
  });

  it("leaves a real file input to take its own drop", () => {
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(input);
    expect(dragEvent("dragover", transfer({}), input).defaultPrevented).toBe(false);
    expect(dragEvent("drop", transfer({}), input).defaultPrevented).toBe(false);
    input.remove();
  });

  it("remembers a drag that started inside the page, even though it carries Files", () => {
    // The browser dresses a dragged <img> as a file.
    const data = transfer({ types: ["text/uri-list", "Files"] });
    expect(isExternalFileDrag(data)).toBe(true);
    dragEvent("dragstart", data);
    expect(isInternalDrag()).toBe(true);
    expect(isExternalFileDrag(data)).toBe(false);
    // ...and does not interfere with where it is dropped.
    expect(dragEvent("dragover", data).defaultPrevented).toBe(false);
    dragEvent("dragend", data);
    expect(isInternalDrag()).toBe(false);
    expect(isExternalFileDrag(data)).toBe(true);
  });

  it("is installed once, however many times it is asked", () => {
    const again = installFileDropGuard(window);
    const data = transfer({});
    const event = dragEvent("dragover", data);
    expect(event.defaultPrevented).toBe(true);
    again();
  });
});

describe("the guard is wired into the app", () => {
  it("is called from the entry point, not just exported", () => {
    // A guard that exists and is never installed is exactly the failure this
    // repo keeps shipping (a heartbeat, a roster delta): every test above
    // passes and a dropped file still replaces the app. Read the entry point.
    const entry = readFileSync(resolve(__dirname, "../main.tsx"), "utf8");
    expect(entry).toMatch(/^installFileDropGuard\(\);$/m);
  });
});
