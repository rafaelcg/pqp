// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * THE ADD DIALOG, from the keyboard. QA found an invisible Tab stop, a name
 * error that outlived the fix, an Enter that did nothing, a hidden-character
 * name that read as "too short", and a focus drop to <body> on Escape.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const upload = vi.fn();

vi.mock("@/lib/soundboard-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundboard-upload")>()),
  inspectSoundboardFile: async () => ({ contentType: "audio/mpeg" }),
  uploadSoundboardFile: (...args: unknown[]) => upload(...args),
}));

const decodes: Array<(buffer: unknown) => void> = [];
const previewed = vi.fn();
const stopped = vi.fn();

vi.mock("@/lib/sounds", () => ({
  sharedAudioContext: () => null,
  decodeAudioBuffer: () => new Promise((resolve) => decodes.push(resolve)),
  unlockSounds: () => undefined,
}));

vi.mock("@/lib/soundboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundboard")>()),
  previewSoundboardBuffer: (...args: unknown[]) => previewed(...args),
  stopSoundboardPreview: () => stopped(),
}));

const { ApiError } = await import("@/lib/api");
const { SoundboardAddDialog } = await import("./soundboard-add-dialog");

let root: Root | null = null;
let host: HTMLElement | null = null;
const onClose = vi.fn();
const onAdded = vi.fn();

function Harness() {
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={openerRef} type="button" data-testid="opener">
        opener
      </button>
      <SoundboardAddDialog
        open
        serverId="s1"
        returnFocusRef={openerRef}
        onClose={onClose}
        onAdded={onAdded}
      />
    </>
  );
}

function Toggle({ open }: { open: boolean }) {
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={openerRef} type="button" data-testid="opener">
        opener
      </button>
      <SoundboardAddDialog
        open={open}
        serverId="s1"
        returnFocusRef={openerRef}
        onClose={onClose}
        onAdded={onAdded}
      />
    </>
  );
}

async function mount(node: React.ReactNode = <Harness />) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

function nameInput(): HTMLInputElement {
  return document.body.querySelector<HTMLInputElement>('input:not([type="file"])')!;
}

function form(): HTMLFormElement {
  return document.body.querySelector("form")!;
}

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function chooseFile() {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array(10)], "clip.mp3", { type: "audio/mpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    form().requestSubmit();
  });
}

function alerts(): string[] {
  return [...document.body.querySelectorAll('[role="alert"]')].map((n) => n.textContent ?? "");
}

beforeEach(() => {
  upload.mockReset();
  onClose.mockReset();
  onAdded.mockReset();
  previewed.mockReset();
  stopped.mockReset();
  decodes.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("soundboard add dialog", () => {
  it("keeps the hidden file input out of the Tab order", async () => {
    await mount();
    const file = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(file.tabIndex).toBe(-1);
  });

  it("clears the name error as soon as the name changes", async () => {
    await mount();
    await chooseFile();
    type(nameInput(), "a");
    await submit();
    expect(alerts()).toContain("Use 2 to 24 characters.");
    type(nameInput(), "ab");
    expect(alerts()).not.toContain("Use 2 to 24 characters.");
    expect(upload).not.toHaveBeenCalled();
  });

  it("clears the file error when another file is chosen", async () => {
    await mount();
    type(nameInput(), "Buzina");
    await submit();
    expect(alerts()).toContain("Choose an audio file.");
    await chooseFile();
    expect(alerts()).not.toContain("Choose an audio file.");
  });

  it("says a name with only invisible characters is not visible, not too short", async () => {
    await mount();
    await chooseFile();
    type(nameInput(), "​​​");
    await submit();
    expect(alerts()).toEqual(["Use letters, numbers or emoji people can see."]);
  });

  it("saves on form submit (Enter) once, even when submitted twice", async () => {
    let resolve!: (value: unknown) => void;
    upload.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount();
    await chooseFile();
    type(nameInput(), "  Buzina ");
    await submit();
    await submit();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0].name).toBe("Buzina");
    await act(async () => resolve({ id: "x" }));
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("claims the stored file again after a lost answer instead of storing it twice", async () => {
    upload.mockImplementationOnce(async (input: { onUploaded: (key: string) => void }) => {
      input.onUploaded("k1");
      throw new ApiError(0, "Network error reaching API.");
    });
    await mount();
    await chooseFile();
    type(nameInput(), "Buzina");
    await submit();
    expect(onAdded).not.toHaveBeenCalled();
    upload.mockResolvedValueOnce({ id: "x" });
    await submit();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]![0].uploadedKey).toBeUndefined();
    expect(upload.mock.calls[1]![0].uploadedKey).toBe("k1");
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("stores the file afresh after a refusal or a new pick", async () => {
    upload.mockImplementation(async (input: { onUploaded: (key: string | null) => void }) => {
      input.onUploaded("k1");
      input.onUploaded(null);
      throw new ApiError(400, "Invalid request");
    });
    await mount();
    await chooseFile();
    type(nameInput(), "Buzina");
    await submit();
    await submit();
    expect(upload.mock.calls[1]![0].uploadedKey).toBeUndefined();
    upload.mockImplementation(async (input: { onUploaded: (key: string) => void }) => {
      input.onUploaded("k2");
      throw new ApiError(0, "Network error reaching API.");
    });
    await submit();
    await chooseFile();
    await submit();
    expect(upload.mock.calls[3]![0].uploadedKey).toBeUndefined();
  });

  it("shows a bad-name 400 on the name, not as a storage failure", async () => {
    upload.mockRejectedValue(new ApiError(400, "Invalid request"));
    await mount();
    await chooseFile();
    type(nameInput(), "Buzina");
    await submit();
    expect(alerts()).toEqual(["That name was not accepted. Try another."]);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("hands focus back to the opener when it closes", async () => {
    await mount(<Toggle open />);
    const opener = document.body.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    await act(async () => {
      root!.render(<Toggle open={false} />);
    });
    expect(document.activeElement).toBe(opener);
  });

  it("previews through the board and drops a decode that a newer click outran", async () => {
    await mount();
    await chooseFile();
    const play = document.body.querySelector<HTMLButtonElement>('button[aria-label="Preview"]')!;
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        play.click();
      });
    }
    expect(decodes).toHaveLength(2);
    // The second decode finishes first; the first one is stale when it lands.
    await act(async () => decodes[1]!("second"));
    await act(async () => decodes[0]!("first"));
    expect(previewed).toHaveBeenCalledTimes(1);
    expect(previewed).toHaveBeenCalledWith("second");
  });

  describe("closing while a save is in flight", () => {
    function Reopenable() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
            reopen
          </button>
          <button type="button" data-testid="shut" onClick={() => setOpen(false)}>
            shut
          </button>
          <SoundboardAddDialog
            open={open}
            serverId="s1"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            onAdded={() => {
              onAdded();
              setOpen(false);
            }}
            onAddedAfterClose={onAddedAfterClose}
          />
        </>
      );
    }

    const onAddedAfterClose = vi.fn();

    async function escape() {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }

    async function reopen() {
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('[data-testid="reopen"]')!.click();
      });
    }

    beforeEach(() => onAddedAfterClose.mockReset());

    it("cancels the upload and never touches the next dialog when it finishes", async () => {
      let resolve!: (value: unknown) => void;
      upload.mockReturnValue(new Promise((r) => (resolve = r)));
      await mount(<Reopenable />);
      await chooseFile();
      type(nameInput(), "Buzina");
      await submit();
      const signal = upload.mock.calls[0]![0].signal as AbortSignal;
      expect(signal.aborted).toBe(false);

      await escape();
      expect(signal.aborted).toBe(true);
      expect(document.body.querySelector("form")).toBeNull();

      await reopen();
      expect(document.body.querySelector("form")).not.toBeNull();
      // The old upload lands now. The new dialog must not be closed by it.
      await act(async () => resolve({ id: "x" }));
      expect(onAdded).not.toHaveBeenCalled();
      expect(document.body.querySelector("form")).not.toBeNull();
      // The clip does exist, so the list is told to refresh.
      expect(onAddedAfterClose).toHaveBeenCalledTimes(1);
    });

    it("drops the stored key when the parent closes the dialog mid-save", async () => {
      upload.mockImplementationOnce(async (input: { onUploaded: (key: string) => void }) => {
        input.onUploaded("k1");
        throw new ApiError(0, "Network error reaching API.");
      });
      await mount(<Reopenable />);
      await chooseFile();
      type(nameInput(), "Buzina");
      await submit();
      let reject!: (error: unknown) => void;
      upload.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
      await submit();
      expect(upload.mock.calls[1]![0].uploadedKey).toBe("k1");
      // Closed by the parent, not the dialog: no reset of the form runs.
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('[data-testid="shut"]')!.click();
      });
      await reopen();
      // The server refused the key, but into a session that is over.
      await act(async () => reject(new ApiError(400, "Invalid request")));
      upload.mockResolvedValueOnce({ id: "x" });
      await submit();
      expect(upload.mock.calls[2]![0].uploadedKey).toBeUndefined();
    });

    it("shows nothing from a failed upload that outlived its dialog", async () => {
      let reject!: (error: unknown) => void;
      upload.mockReturnValue(new Promise((_, r) => (reject = r)));
      await mount(<Reopenable />);
      await chooseFile();
      type(nameInput(), "Buzina");
      await submit();
      await escape();
      await reopen();
      await act(async () => reject(new ApiError(409, "slots")));
      expect(alerts()).toEqual([]);
      expect(onAddedAfterClose).not.toHaveBeenCalled();
      // And the new dialog can save: the old save did not leave it locked.
      upload.mockResolvedValue({ id: "y" });
      await chooseFile();
      type(nameInput(), "Risada");
      await submit();
      expect(upload).toHaveBeenCalledTimes(2);
      expect(onAdded).toHaveBeenCalledTimes(1);
    });

    it("stops a running preview when the dialog closes, however it closes", async () => {
      await mount(<Reopenable />);
      expect(stopped).not.toHaveBeenCalled();
      await escape();
      expect(stopped).toHaveBeenCalled();
    });

    it("drops a preview decode that finishes after the dialog closed", async () => {
      await mount(<Reopenable />);
      await chooseFile();
      const play = document.body.querySelector<HTMLButtonElement>('button[aria-label="Preview"]')!;
      await act(async () => {
        play.click();
      });
      await escape();
      await act(async () => decodes[0]!("late"));
      expect(previewed).not.toHaveBeenCalled();
    });

    it("uses the API's cap in the full-board message", async () => {
      upload.mockRejectedValue(new ApiError(409, "slots"));
      await mount(
        <SoundboardAddDialog
          open
          serverId="s1"
          maxSounds={30}
          onClose={onClose}
          onAdded={onAdded}
        />,
      );
      await chooseFile();
      type(nameInput(), "Buzina");
      await submit();
      expect(alerts()).toEqual(["This server already has 30 sounds."]);
    });
  });
});
