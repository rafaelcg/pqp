export type PickResult =
  | { kind: "picked"; bytes: ArrayBuffer; ext: string }
  | { kind: "cancelled" }
  | { kind: "too-large" }
  | { kind: "wrong-type" };

export interface PickOptions {
  /** The manifest's `localFiles.accept`: extensions with their dot, lower case. */
  accept: readonly string[];
  /** The manifest's `localFiles.maxBytes`. */
  maxBytes: number;
  doc?: Document;
  /** Rejects the pick when it returns true (the host went away while the picker was open). */
  aborted?: () => boolean;
}

/** `.GBA` becomes `.gba`; no dot, or a dot at the very start, is no extension. */
export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot).toLowerCase();
}

/**
 * Reads one file the person handed the page (from a picker, or dropped on the
 * guest player's door) under the manifest's rules: an extension on the accept
 * list and at most `maxBytes`. The name is read once for the extension and goes
 * no further; what comes back is the bytes and that extension.
 */
export async function readLocalFile(
  file: File,
  options: Pick<PickOptions, "accept" | "maxBytes" | "aborted">,
): Promise<PickResult> {
  const ext = extensionOf(file.name);
  if (ext === null || !options.accept.includes(ext)) return { kind: "wrong-type" };
  if (file.size > options.maxBytes) return { kind: "too-large" };
  try {
    const bytes = await file.arrayBuffer();
    return options.aborted?.() ? { kind: "cancelled" } : { kind: "picked", bytes, ext };
  } catch {
    return { kind: "cancelled" };
  }
}

/**
 * Opens a file picker owned by the pqp page, never by the app, and reads the
 * file the person chose. What comes back is the bytes and the lower-cased
 * extension taken from the manifest's closed accept list: the file name is read
 * once to find that extension and is not kept, logged or passed on.
 *
 * Call it from the handler of a message the person's own click caused (the
 * app's button), so the browser still treats the page as user-activated.
 */
export function pickLocalFile(options: PickOptions): Promise<PickResult> {
  const doc = options.doc ?? document;
  return new Promise<PickResult>((resolve) => {
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = options.accept.join(",");
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");

    let done = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PickResult) => {
      if (done) return;
      done = true;
      clearTimeout(focusTimer);
      doc.defaultView?.removeEventListener("focus", onFocus);
      input.remove();
      resolve(result);
    };

    // Browsers that do not fire `cancel` on a file input: the window takes focus
    // back when the dialog closes, and `change` (if any) follows within moments.
    const onFocus = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!input.files || input.files.length === 0) finish({ kind: "cancelled" });
      }, 700);
    };

    input.addEventListener("cancel", () => finish({ kind: "cancelled" }));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file || options.aborted?.()) return finish({ kind: "cancelled" });
      void readLocalFile(file, options).then(finish);
    });

    doc.body.append(input);
    doc.defaultView?.addEventListener("focus", onFocus, { once: true });
    input.click();
  });
}
