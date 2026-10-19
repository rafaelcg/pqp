// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestConfigRefresh } from "@/lib/config-refresh";
import { EmulatorRoom } from "./emulator-room";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const configAnswer = vi.hoisted(() => ({ enabled: false, fail: false }));
const configCalls = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchEmulatorConfig: vi.fn(async (serverId: string) => {
      configCalls.ids.push(serverId);
      if (configAnswer.fail) {
        throw new Error("network");
      }
      return { enabled: configAnswer.enabled };
    }),
  };
});

const SERVER = "11111111-1111-4111-8111-111111111111";

let root: Root | null = null;
let host: HTMLElement | null = null;
const fetchSpy = vi.fn();
const xhrOpenSpy = vi.fn();
const beaconSpy = vi.fn();

beforeEach(() => {
  configAnswer.enabled = false;
  configAnswer.fail = false;
  configCalls.ids = [];
  fetchSpy.mockReset();
  xhrOpenSpy.mockReset();
  beaconSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal(
    "XMLHttpRequest",
    class {
      open = xhrOpenSpy;
      send = vi.fn();
    },
  );
  Object.defineProperty(navigator, "sendBeacon", { value: beaconSpy, configurable: true });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount(open: boolean) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<EmulatorRoom serverId={SERVER} open={open} onClose={() => {}} />);
  });
}

const dialogRoot = () => document.querySelector('[role="dialog"]');
const fileInput = () =>
  document.querySelector<HTMLInputElement>('[data-testid="emulator-file-input"]');
const frame = () => document.querySelector<HTMLIFrameElement>("iframe");

function pickFile(file: File) {
  const input = fileInput()!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** The frame saying it can take a file, as frame.js does. */
function frameReady() {
  const target = frame()!.contentWindow!;
  const postMessage = vi.spyOn(target, "postMessage");
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "pqp-emulator-ready" },
        // A sandboxed frame has an opaque origin, which a receiver sees as "null".
        origin: "null",
        source: target,
      }),
    );
  });
  return postMessage;
}

describe("the emulator room with the flag off", () => {
  it("draws nothing at all, even when somebody asked to open it", async () => {
    configAnswer.enabled = false;
    await mount(true);
    expect(dialogRoot()).toBeNull();
    expect(fileInput()).toBeNull();
    expect(frame()).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("asks the server only for the flag, and for the server it was opened from", async () => {
    await mount(true);
    expect(configCalls.ids).toEqual([SERVER]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
  });
});

describe("the emulator room with the flag on", () => {
  it("stays closed until opened, then says plainly that pqp provides no games", async () => {
    configAnswer.enabled = true;
    await mount(false);
    expect(dialogRoot()).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    await mount(true);
    expect(dialogRoot()).not.toBeNull();
    expect(dialogRoot()!.textContent).toContain("pqp does not provide games");
    expect(dialogRoot()!.textContent).toContain("never uploads it");
    // No game list of any kind, only the picker.
    expect(frame()).toBeNull();
    expect(fileInput()!.accept).toBe(".nes,.gb,.gbc,.gba");
  });

  it("refuses a file that is not one of the supported systems, without loading anything", async () => {
    configAnswer.enabled = true;
    await mount(true);
    pickFile(new File([new Uint8Array(16)], "something.zip"));
    expect(frame()).toBeNull();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("not one we can open");
  });

  it("hands the picked file to the frame in memory and sends it nowhere else", async () => {
    configAnswer.enabled = true;
    await mount(true);

    const file = new File([new Uint8Array([1, 2, 3, 4])], "my-own-game.gba");
    pickFile(file);

    // The frame is a fixed page: the file's name is nowhere in it, and it is
    // sandboxed into an opaque origin (scripts only, never `allow-same-origin`).
    const src = frame()!.getAttribute("src")!;
    expect(src).toBe(`/emulator/frame.html?o=${encodeURIComponent(window.location.origin)}`);
    expect(src).not.toContain("my-own-game");
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame()!.getAttribute("referrerpolicy")).toBe("no-referrer");

    const postMessage = frameReady();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message, targetOrigin] = postMessage.mock.calls[0]!;
    // An opaque-origin frame cannot be named as a target; the target is its
    // window object, which only this page holds.
    expect(targetOrigin).toBe("*");
    expect((message as { type: string }).type).toBe("pqp-emulator-load");
    expect((message as { file: File }).file).toBe(file);

    // THE POINT: with the file picked and handed over, no request of any kind
    // was made, so no request can carry it.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpenSpy).not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[1]?.body ?? "")).not.toContain("my-own-game");
    }
  });

  it("does not talk to a message that did not come from its own frame", async () => {
    configAnswer.enabled = true;
    await mount(true);
    pickFile(new File([new Uint8Array(4)], "x.nes"));
    const target = frame()!.contentWindow!;
    const postMessage = vi.spyOn(target, "postMessage");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "pqp-emulator-ready" },
          origin: "https://evil.example",
          source: target,
        }),
      );
      // The app's own origin is NOT the frame's: a frame that somehow shared it
      // would be the isolation failing.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "pqp-emulator-ready" },
          origin: window.location.origin,
          source: target,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "pqp-emulator-ready" },
          origin: "null",
          source: window,
        }),
      );
    });
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("a frame that never answers, and a flag that stops answering", () => {
  it("gives up on a frame that never says ready: drops the file and shows the load error", async () => {
    vi.useFakeTimers();
    try {
      configAnswer.enabled = true;
      await mount(true);
      pickFile(new File([new Uint8Array(4)], "x.nes"));
      expect(frame()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(10_001);
      });
      expect(frame()).toBeNull();
      expect(document.querySelector('[role="alert"]')!.textContent).toContain(
        "could not start",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a frame that said ready but never finishes starting, and not on one that does", async () => {
    vi.useFakeTimers();
    try {
      configAnswer.enabled = true;
      await mount(true);
      pickFile(new File([new Uint8Array(4)], "x.nes"));
      frameReady();
      act(() => {
        vi.advanceTimersByTime(89_000);
      });
      expect(frame()).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(frame()).toBeNull();
      expect(document.querySelector('[role="alert"]')!.textContent).toContain("could not start");

      // Again, this time the emulator reports it is up.
      pickFile(new File([new Uint8Array(4)], "x.nes"));
      frameReady();
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "pqp-emulator-initialized" },
            origin: "null",
            source: frame()!.contentWindow,
          }),
        );
        vi.advanceTimersByTime(120_000);
      });
      expect(frame()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the load error when the frame reports the emulator failed", async () => {
    configAnswer.enabled = true;
    await mount(true);
    pickFile(new File([new Uint8Array(4)], "x.gba"));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "pqp-emulator-error", reason: "load" },
          origin: "null",
          source: frame()!.contentWindow,
        }),
      );
    });
    expect(frame()).toBeNull();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("could not start");
  });

  it("does not give up on a frame that did say ready", async () => {
    vi.useFakeTimers();
    try {
      configAnswer.enabled = true;
      await mount(true);
      pickFile(new File([new Uint8Array(4)], "x.nes"));
      frameReady();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(frame()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes when the flag read fails after it was on (a failed read is off)", async () => {
    configAnswer.enabled = true;
    await mount(true);
    expect(dialogRoot()).not.toBeNull();
    configAnswer.fail = true;
    await act(async () => {
      requestConfigRefresh({ force: true });
    });
    expect(dialogRoot()).toBeNull();
  });
});

describe("the emulator room's source", () => {
  const dir = import.meta.dirname;
  const sources = [
    path.join(dir, "emulator-room.tsx"),
    path.join(dir, "../../lib/emulator/use-emulator-enabled.ts"),
    path.join(dir, "../../lib/emulator/systems.ts"),
    path.join(dir, "../../lib/emulator/allowlist.ts"),
  ];

  it("has no way to send a file anywhere: no fetch, XHR, beacon, form data, socket or storage", () => {
    for (const file of sources) {
      const text = readFileSync(file, "utf8")
        // The header comments say what it must not do; only code counts.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of [
        /\bfetch\(/,
        /\bXMLHttpRequest\b/,
        /\bsendBeacon\b/,
        /\bFormData\b/,
        /\bWebSocket\b/,
        /\blocalStorage\b/,
        /\bsessionStorage\b/,
        /\bindexedDB\b/,
        /\bFileReader\b/,
        /\bcreateObjectURL\b/,
        /\bconsole\./,
        /\btrack\(/,
        /\bapiFetch\b/,
      ]) {
        expect(text, `${path.basename(file)} must not use ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("sandboxes the frame without same-origin and names no same-origin allowance", () => {
    const text = readFileSync(sources[0]!, "utf8");
    expect(text).toContain('sandbox="allow-scripts"');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("allow-same-origin");
    expect(code).not.toMatch(/allow-(top-navigation|popups|forms|modals|downloads)/);
  });

  it("never reads the picked file's name into anything but the extension check", () => {
    const text = readFileSync(sources[0]!, "utf8");
    const uses = [...text.matchAll(/\bfile\.name\b/g)];
    expect(uses).toHaveLength(1);
    expect(text).toContain("systemForFileName(file.name)");
  });
});
