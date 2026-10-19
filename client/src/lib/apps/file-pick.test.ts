// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionOf, pickLocalFile } from "./file-pick";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Makes the next `input.click()` behave like a person choosing `files` (or cancelling with none). */
function person(action: { files: File[] } | "cancel") {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    queueMicrotask(() => {
      if (action === "cancel") {
        this.dispatchEvent(new Event("cancel"));
        return;
      }
      Object.defineProperty(this, "files", { configurable: true, value: action.files });
      this.dispatchEvent(new Event("change"));
    });
  });
}

const accept = [".gba", ".nes"] as const;

describe("extensionOf", () => {
  it("lower-cases the last extension and refuses a name with none", () => {
    expect(extensionOf("Game.GBA")).toBe(".gba");
    expect(extensionOf("a.b.NES")).toBe(".nes");
    expect(extensionOf("noext")).toBeNull();
    expect(extensionOf(".hidden")).toBeNull();
    expect(extensionOf("trailing.")).toBeNull();
  });
});

describe("pickLocalFile", () => {
  it("reads the file and returns its bytes and extension, and nothing that names the file", async () => {
    person({ files: [new File([new Uint8Array([7, 8, 9])], "My Secret Title.GBA")] });
    const result = await pickLocalFile({ accept, maxBytes: 1024 });
    expect(result.kind).toBe("picked");
    if (result.kind !== "picked") return;
    expect(result.ext).toBe(".gba");
    expect(Array.from(new Uint8Array(result.bytes))).toEqual([7, 8, 9]);
    expect(Object.keys(result).sort()).toEqual(["bytes", "ext", "kind"]);
    expect(JSON.stringify({ ...result, bytes: undefined })).not.toMatch(/secret|title/i);
  });

  it("creates the picker with the manifest's accept list, hidden, and removes it afterwards", async () => {
    const created: HTMLInputElement[] = [];
    const real = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = real(tag);
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    }) as typeof document.createElement);
    person({ files: [new File(["x"], "a.nes")] });
    await pickLocalFile({ accept, maxBytes: 1024 });
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("file");
    expect(created[0]!.accept).toBe(".gba,.nes");
    expect(created[0]!.hidden).toBe(true);
    expect(document.body.contains(created[0]!)).toBe(false);
  });

  it("is cancelled when the person cancels", async () => {
    person("cancel");
    expect(await pickLocalFile({ accept, maxBytes: 1024 })).toEqual({ kind: "cancelled" });
  });

  it("is cancelled when nothing is chosen and the window takes focus back (browsers without a cancel event)", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {
      queueMicrotask(() => window.dispatchEvent(new Event("focus")));
    });
    const result = pickLocalFile({ accept, maxBytes: 1024 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ kind: "cancelled" });
    vi.useRealTimers();
  });

  it("refuses a file over the cap before reading it", async () => {
    const big = new File([new Uint8Array(2048)], "big.gba");
    const read = vi.spyOn(big, "arrayBuffer");
    person({ files: [big] });
    expect(await pickLocalFile({ accept, maxBytes: 1024 })).toEqual({ kind: "too-large" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an extension that is not in the accept list, or no extension", async () => {
    person({ files: [new File(["x"], "game.zip")] });
    expect(await pickLocalFile({ accept, maxBytes: 1024 })).toEqual({ kind: "wrong-type" });
    person({ files: [new File(["x"], "game")] });
    expect(await pickLocalFile({ accept, maxBytes: 1024 })).toEqual({ kind: "wrong-type" });
  });

  it("is cancelled when the host went away while the picker was open", async () => {
    person({ files: [new File(["x"], "a.gba")] });
    expect(await pickLocalFile({ accept, maxBytes: 1024, aborted: () => true })).toEqual({ kind: "cancelled" });
  });
});
