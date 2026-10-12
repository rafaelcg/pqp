// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE SOUNDBOARD SETTINGS LIST, from the keyboard and from a screen reader.
 * QA found 24 "Preview" buttons with one name, a delete with no confirmation,
 * no rename, a counter that disagreed with the server's cap, and a volume
 * slider that sent one request per arrow key.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip = (id: string, name: string, volume = 1) => ({
  id,
  name,
  emoji: "✨",
  contentType: "audio/mpeg" as const,
  byteSize: 1000,
  durationMs: 1000,
  volume,
  url: null,
});

const board = {
  sounds: [clip("a", "Buzina"), clip("b", "Risada"), clip("c", "Grilo", 0.6)],
  maxSounds: 24,
  slotsUsed: undefined as number | undefined,
};
const update = vi.fn();
const remove = vi.fn();
const fetched = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSoundboard: async () => {
    fetched();
    return {
    sounds: board.sounds,
    maxSounds: board.maxSounds,
    slotsUsed: board.slotsUsed,
    };
  },
  updateSoundboardSound: (...args: unknown[]) => update(...args),
  deleteSoundboardSound: (...args: unknown[]) => remove(...args),
}));

vi.mock("@/lib/soundboard", () => ({
  noteSoundboardCatalog: () => undefined,
  warmSoundboardBuiltins: async () => undefined,
  previewSoundboardClip: () => undefined,
  stopSoundboardPreview: () => undefined,
}));

vi.mock("@/components/voice/soundboard-add-dialog", () => ({
  SoundboardAddDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-dialog" /> : null,
}));

const { ApiError } = await import("@/lib/api");
const { SoundboardSettingsSection } = await import("./soundboard-settings-section");

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SoundboardSettingsSection serverId="s1" />);
  });
}

function byLabel(label: string): HTMLButtonElement {
  const el = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!el) {
    throw new Error(`no element labelled ${label}`);
  }
  return el;
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

function renameInput(name: string): HTMLInputElement {
  return byLabel(`New name for ${name}`) as unknown as HTMLInputElement;
}

beforeEach(() => {
  board.sounds = [clip("a", "Buzina"), clip("b", "Risada"), clip("c", "Grilo", 0.6)];
  board.slotsUsed = undefined;
  update.mockReset();
  remove.mockReset();
  fetched.mockReset();
  update.mockImplementation(async (_s: string, id: string, body: { name?: string }) => {
    board.sounds = board.sounds.map((c) => (c.id === id ? { ...c, ...body } : c));
    return { sound: board.sounds.find((c) => c.id === id) };
  });
  remove.mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function addButton(): HTMLButtonElement {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Add",
  )!;
}

describe("soundboard settings list", () => {
  it("gives every preview button its clip's name", async () => {
    await mount();
    const labels = [...document.body.querySelectorAll<HTMLElement>("li > button")]
      .map((b) => b.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Preview"));
    expect(labels).toEqual(["Preview Buzina", "Preview Risada", "Preview Grilo"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("counts what the server counts and disables Add at the cap", async () => {
    // 21 stored, 3 uploads in flight: the server says full.
    board.sounds = Array.from({ length: 21 }, (_, i) => clip(`id${i}`, `Clip ${i}`));
    board.slotsUsed = 24;
    await mount();
    expect(document.body.textContent).toContain("21 of 24 custom sounds");
    expect(document.body.textContent).toContain("3 uploads in progress");
    expect(document.body.textContent).toContain("The board is full while uploads finish.");
    expect(addButton().getAttribute("aria-disabled")).toBe("true");
    await click(addButton());
    expect(document.body.querySelector('[data-testid="add-dialog"]')).toBeNull();
  });

  it("opens the add dialog below the cap", async () => {
    await mount();
    expect(document.body.textContent).toContain("3 of 24 custom sounds");
    expect(addButton().hasAttribute("aria-disabled")).toBe(false);
    await click(addButton());
    expect(document.body.querySelector('[data-testid="add-dialog"]')).not.toBeNull();
  });
});

describe("switching servers on the same page", () => {
  it("clears the last server's clips until the new server's list arrives", async () => {
    await mount();
    expect(document.body.textContent).toContain("Buzina");
    let answer: (page: unknown) => void = () => undefined;
    const api = await import("@/lib/api");
    const spy = vi
      .spyOn(api, "fetchSoundboard")
      .mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
    try {
      await act(async () => {
        root!.render(<SoundboardSettingsSection serverId="s2" />);
      });
      expect(document.body.textContent).not.toContain("Buzina");
      await act(async () => {
        answer({ sounds: [clip("z", "Apito")], maxSounds: 6, slotsUsed: 1 });
      });
      expect(document.body.textContent).toContain("Apito");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("renaming", () => {
  it("saves the new name with Enter, updates the row and returns focus to the pencil", async () => {
    await mount();
    await click(byLabel("Rename Buzina"));
    const input = renameInput("Buzina");
    expect(document.activeElement).toBe(input);
    type(input, "Corneta");
    await act(async () => {
      input.form!.requestSubmit();
    });
    expect(update).toHaveBeenCalledWith("s1", "a", { name: "Corneta" });
    expect(document.body.textContent).toContain("Corneta");
    expect(document.activeElement).toBe(byLabel("Rename Corneta"));
  });

  it("cancels with Escape without saving, and without closing anything behind it", async () => {
    await mount();
    const behind = vi.fn();
    document.addEventListener("keydown", behind, true);
    await click(byLabel("Rename Buzina"));
    const input = renameInput("Buzina");
    type(input, "Corneta");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    document.removeEventListener("keydown", behind, true);
    expect(update).not.toHaveBeenCalled();
    expect(behind).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Buzina");
    expect(document.activeElement).toBe(byLabel("Rename Buzina"));
  });

  it("refuses a name with only invisible characters and says why", async () => {
    await mount();
    await click(byLabel("Rename Buzina"));
    const input = renameInput("Buzina");
    type(input, "\u200B\u200B");
    await act(async () => {
      input.form!.requestSubmit();
    });
    expect(update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Use letters, numbers or emoji people can see.");
  });
});

describe("deleting", () => {
  it("asks first, and deletes only on confirm", async () => {
    await mount();
    await click(byLabel("Delete Risada"));
    expect(remove).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete Risada?");
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Delete",
    )!;
    board.sounds = board.sounds.filter((c) => c.id !== "b");
    await click(confirm);
    expect(remove).toHaveBeenCalledWith("s1", "b");
    // The row that held focus is gone: focus lands on its neighbour.
    expect(document.activeElement).toBe(byLabel("Preview Grilo"));
  });

  it("does nothing when the person backs out", async () => {
    await mount();
    await click(byLabel("Delete Risada"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Cancel",
    )!;
    await click(cancel);
    expect(remove).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("clip volume", () => {
  it("saves once after the last arrow key, and names the value", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await mount();
    const slider = document.body.querySelector<HTMLElement>('[role="slider"][aria-label="Volume for Grilo"]')!;
    expect(slider.getAttribute("aria-valuetext")).toBe("60%");
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        slider.focus();
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
    }
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(update).toHaveBeenCalledTimes(1);
    const [, id, body] = update.mock.calls[0]!;
    expect(id).toBe("c");
    expect(body.volume).toBeCloseTo(0.75);
    expect(slider.getAttribute("aria-valuetext")).toBe("75%");
  });
});

describe("when the settings page and the server disagree", () => {
  it("cancels only the rename on Escape after the person clicked away from the field", async () => {
    await mount();
    const behind = vi.fn();
    document.addEventListener("keydown", behind, true);
    await click(byLabel("Rename Buzina"));
    type(renameInput("Buzina"), "Corneta");
    // Focus leaves the field, as a click on empty space does.
    await act(async () => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    document.removeEventListener("keydown", behind, true);
    // The window listener took it ahead of the settings dialog's own.
    expect(behind).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(document.body.querySelector('input[aria-label^="New name"]')).toBeNull();
    expect(document.body.textContent).toContain("Buzina");
  });

  it("leaves Escape to the delete confirmation while one is open over a rename", async () => {
    await mount();
    await click(byLabel("Rename Buzina"));
    await click(byLabel("Delete Risada"));
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.body.querySelector('input[aria-label^="New name"]')).not.toBeNull();
  });

  it("treats renaming a clip someone else deleted as done, and refreshes the list", async () => {
    await mount();
    update.mockRejectedValueOnce(new ApiError(404, "Sound not found"));
    await click(byLabel("Rename Buzina"));
    const input = renameInput("Buzina");
    type(input, "Corneta");
    board.sounds = board.sounds.filter((c) => c.id !== "a");
    const before = fetched.mock.calls.length;
    await act(async () => {
      input.form!.requestSubmit();
    });
    expect(fetched.mock.calls.length).toBeGreaterThan(before);
    expect(document.body.textContent).not.toContain("Could not save");
    expect(document.body.textContent).not.toContain("Buzina");
    expect(document.body.querySelector('input[aria-label^="New name"]')).toBeNull();
  });

  it("treats deleting a clip someone else deleted as done, with no error", async () => {
    await mount();
    remove.mockRejectedValueOnce(new ApiError(404, "Sound not found"));
    await click(byLabel("Delete Risada"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Delete",
    )!;
    board.sounds = board.sounds.filter((c) => c.id !== "b");
    await click(confirm);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Risada");
  });

  it("says a delete failed, not that a save did", async () => {
    await mount();
    remove.mockRejectedValueOnce(new ApiError(503, "storage"));
    await click(byLabel("Delete Risada"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Delete",
    )!;
    await click(confirm);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not delete that sound.",
    );
  });

  it("shows stored clips as the count and asks again while uploads hold slots", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    board.slotsUsed = 4;
    await mount();
    expect(document.body.textContent).toContain("3 of 24 custom sounds");
    expect(document.body.textContent).toContain("1 upload in progress");
    // Room is left, so Add stays open and no "full" sentence is shown.
    expect(addButton().hasAttribute("aria-disabled")).toBe(false);
    expect(document.body.textContent).not.toContain("The board is full");
    const calls = fetched.mock.calls.length;
    board.slotsUsed = undefined;
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    expect(fetched.mock.calls.length).toBeGreaterThan(calls);
    expect(document.body.textContent).not.toContain("upload in progress");
  });
});
