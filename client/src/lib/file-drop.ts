/**
 * Dropping files onto the app, in the browser and in the desktop shell.
 *
 * Three jobs live here, kept in one file because they have to agree about what
 * "a file drag" means:
 *
 *  1. `isFileDrag` / `isExternalFileDrag`: is this drag carrying files at all,
 *     and did it come from outside the page?
 *  2. `readDroppedItems`: the files out of a drop, with folders told apart from
 *     files instead of being handed on as empty, typeless "files".
 *  3. `installFileDropGuard`: the page-wide net. A file dropped on anything that
 *     is not a drop zone must never be left to the browser, because the
 *     browser's answer is to NAVIGATE to the file and replace the whole app
 *     (a call in progress included). Electron does the same, to `file://`.
 *
 * The drop zones themselves are `useFileDropZone` (`hooks/use-file-drop-zone`).
 */

/** What a drop carried, split into the part we can upload and the part we cannot. */
export interface DroppedItems {
  files: File[];
  /** Names of dropped directories. A directory cannot be uploaded; the zone says so. */
  folders: string[];
}

/** True when a drag is carrying files rather than selected text or a link. */
export function isFileDrag(data: DataTransfer | null | undefined): boolean {
  return [...(data?.types ?? [])].includes("Files");
}

/**
 * A drag that started inside this page is never a file drop, even when it
 * carries "Files".
 *
 * Chromium puts a synthesised file on the drag of an `<img>` (an avatar, an
 * attachment in the transcript), so `types` alone cannot tell "a screenshot
 * from the desktop" from "somebody picking up a picture that is already
 * here". `dragstart` only ever fires for the second kind, so the guard below
 * remembers it for the length of that drag.
 */
let internalDrag = false;

export function isInternalDrag(): boolean {
  return internalDrag;
}

/** A file drag from outside the page: the only kind a drop zone reacts to. */
export function isExternalFileDrag(
  data: DataTransfer | null | undefined,
): boolean {
  return !internalDrag && isFileDrag(data);
}

/** Test seam: the module-level flag would otherwise leak between cases. */
export function resetInternalDragForTests(): void {
  internalDrag = false;
}

/** The files out of a paste or a drop. Directories are not files. */
export function filesFromDataTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  return readDroppedItems(data).files;
}

interface EntryLike {
  isDirectory: boolean;
  name: string;
}

function entryOf(item: DataTransferItem): EntryLike | null {
  // `webkitGetAsEntry` is the (prefixed, universally shipped) way to ask what a
  // dropped item IS. It is absent on a paste's items in some engines, and in
  // the test doubles, which is why it is optional here.
  const getter = (
    item as DataTransferItem & {
      webkitGetAsEntry?: () => EntryLike | null;
    }
  ).webkitGetAsEntry;
  if (typeof getter !== "function") {
    return null;
  }
  try {
    return getter.call(item);
  } catch {
    return null;
  }
}

/**
 * Files and folders out of a paste or a drop.
 *
 * `files` is the primary source because a screenshot paste puts several
 * representations on the clipboard at once (the image, plus HTML markup
 * wrapping it) and only `files` is already filtered down to the bytes. It is
 * NOT enough on its own for a drop, though: Chromium lists a dropped folder in
 * `files` as a zero-length file with no type, which then fails the type check
 * as "unrecognised file type" and reads like our bug. `items` is the only place
 * that says the thing is a directory, so it is consulted first, and read in the
 * same tick as the event: the list is emptied once the handler returns.
 */
export function readDroppedItems(
  data: DataTransfer | null | undefined,
): DroppedItems {
  if (!data) {
    return { files: [], folders: [] };
  }

  const items = [...(data.items ?? [])].filter((item) => item.kind === "file");
  const folders: string[] = [];
  const itemFiles: File[] = [];
  for (const item of items) {
    const entry = entryOf(item);
    if (entry?.isDirectory) {
      folders.push(entry.name);
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      itemFiles.push(file);
    }
  }

  if (folders.length > 0) {
    // `files` would still contain the folders' placeholders, so it cannot be
    // used here. The item list has already been filtered.
    return { files: itemFiles, folders };
  }
  if (data.files?.length) {
    return { files: [...data.files], folders: [] };
  }
  return { files: itemFiles, folders: [] };
}

/**
 * What a single-file picker (an avatar, a banner, a server icon) takes from a
 * drop: the first file, else the name of a folder to say no to. A second file
 * is ignored rather than refused, the same as a multi-select in the OS picker
 * would be if the control only keeps one.
 */
export function firstDroppedFile(items: DroppedItems): {
  file: File | null;
  folder: string | null;
} {
  return {
    file: items.files[0] ?? null,
    folder: items.files.length === 0 ? (items.folders[0] ?? null) : null,
  };
}

/** A real file input takes a drop natively; interfering would break it. */
function isNativeFileInput(target: EventTarget | null): boolean {
  return (
    typeof HTMLInputElement !== "undefined" &&
    target instanceof HTMLInputElement &&
    target.type === "file"
  );
}

let guardInstalled = false;

/**
 * Page-wide net under every drop zone.
 *
 * A drop that no zone claimed is NOT a no-op. The browser opens the file in
 * place of the app, and the desktop shell tries to navigate the window to it
 * (the shell blocks that too, `electron/lib/nav-policy.js`, but a page that
 * never asks is better than a navigation that is refused). So: any external
 * file drag that reaches `window` unclaimed is told "none", which gives the
 * no-drop cursor and means no drop event is delivered at all, and any drop
 * that arrives anyway is cancelled.
 *
 * It runs on `window`, after React's root listeners, so `defaultPrevented`
 * already says whether a zone took the drag. A drag from outside is the only
 * thing it touches: text, links and pqp's own drags (channel reordering,
 * queue sorting) keep their defaults.
 *
 * Idempotent; returns the uninstall.
 */
export function installFileDropGuard(win: Window = window): () => void {
  if (guardInstalled) {
    return () => {};
  }
  guardInstalled = true;

  const onDragStart = () => {
    internalDrag = true;
  };
  const onDragEnd = () => {
    internalDrag = false;
  };
  const onDragOver = (event: DragEvent) => {
    if (
      event.defaultPrevented ||
      !isExternalFileDrag(event.dataTransfer) ||
      isNativeFileInput(event.target)
    ) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };
  const onDrop = (event: DragEvent) => {
    // The drag is over either way; clear the flag in case `dragend` was missed
    // (it fires on the source, which a re-render may have removed).
    const wasInternal = internalDrag;
    internalDrag = false;
    if (
      event.defaultPrevented ||
      wasInternal ||
      !isFileDrag(event.dataTransfer) ||
      isNativeFileInput(event.target)
    ) {
      return;
    }
    event.preventDefault();
  };

  win.addEventListener("dragstart", onDragStart, true);
  win.addEventListener("dragend", onDragEnd, true);
  win.addEventListener("dragover", onDragOver);
  win.addEventListener("drop", onDrop);

  return () => {
    guardInstalled = false;
    internalDrag = false;
    win.removeEventListener("dragstart", onDragStart, true);
    win.removeEventListener("dragend", onDragEnd, true);
    win.removeEventListener("dragover", onDragOver);
    win.removeEventListener("drop", onDrop);
  };
}
