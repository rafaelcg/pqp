// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The avatar picker's own behaviour: the ready-made set is a radio group, and
 * the link field shows only a link somebody typed.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchAvatarConfig: () => Promise.resolve({ enabled: false }),
}));

import { AVATAR_PRESETS, AvatarPicker } from "./avatar-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const labels = {
  urlPlaceholder: "https://example.com/a.png",
  urlLabel: "Image link (https://…)",
  presets: "Ready-made avatars",
  preset: (name: string) => `Ready-made avatar, ${name}`,
  presetName: (number: number) => `name ${number}`,
  presetSelected: (name: string) => `Selected: ${name}`,
  remove: "Remove",
  useLink: "Use a link",
  upload: "Upload",
  uploading: "Uploading",
  uploadFailed: "Upload failed",
};

const changes: string[] = [];
const submit = vi.fn();

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AvatarPicker
      value={value}
      onChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
      fallbackName="Dev"
      onSubmit={submit}
      labels={labels}
    />
  );
}

async function mount(initial = "") {
  changes.length = 0;
  submit.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness initial={initial} />);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const radios = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });

describe("AvatarPicker presets", () => {
  it("is a radio group with a described name per preset, none of them numbered", async () => {
    await mount();
    expect(host!.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
      "Ready-made avatars",
    );
    expect(radios()).toHaveLength(AVATAR_PRESETS.length);
    expect(radios()[2].getAttribute("aria-label")).toBe("Ready-made avatar, name 3");
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    expect(host!.textContent).not.toContain("Selected:");
  });

  it("has one Tab stop: the first preset, or the chosen one", async () => {
    await mount();
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);
    act(() => root?.unmount());
    host?.remove();
    await mount(AVATAR_PRESETS[3]);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0, -1, -1, -1, -1]);
    expect(radios()[3].getAttribute("aria-checked")).toBe("true");
    expect(host!.textContent).toContain("Selected: name 4");
  });

  it("moves with the arrow keys, wraps, and chooses what it lands on", async () => {
    await mount(AVATAR_PRESETS[0]);
    act(() => radios()[0].focus());
    key(radios()[0], "ArrowRight");
    expect(document.activeElement).toBe(radios()[1]);
    expect(changes).toEqual([AVATAR_PRESETS[1]]);
    key(radios()[1], "ArrowLeft");
    key(radios()[0], "ArrowLeft");
    expect(document.activeElement).toBe(radios()[7]);
    expect(changes.at(-1)).toBe(AVATAR_PRESETS[7]);
    key(radios()[7], "Home");
    expect(changes.at(-1)).toBe(AVATAR_PRESETS[0]);
    key(radios()[0], "End");
    expect(changes.at(-1)).toBe(AVATAR_PRESETS[7]);
    expect(radios()[7].getAttribute("aria-checked")).toBe("true");
  });
});

describe("AvatarPicker on a phone", () => {
  it("makes every target 44px and lays the eight presets out four by two", async () => {
    await mount(AVATAR_PRESETS[0]);
    expect(host!.querySelector('[role="radiogroup"]')?.className).toContain("max-sm:grid-cols-4");
    for (const radio of radios()) {
      expect(radio.className).toContain("max-sm:h-11");
      expect(radio.className).toContain("max-sm:w-11");
    }
    for (const button of host!.querySelectorAll<HTMLButtonElement>("button:not([role])")) {
      expect(button.className).toContain("max-sm:h-11");
    }
  });
});

describe("AvatarPicker link field", () => {
  const openLink = async () => {
    const button = Array.from(host!.querySelectorAll("button")).find(
      (b) => b.textContent === "Use a link",
    )!;
    await act(async () => button.click());
    return host!.querySelector<HTMLInputElement>("input")!;
  };

  it("has a visible label and starts empty when a preset is chosen", async () => {
    await mount(AVATAR_PRESETS[1]);
    const input = await openLink();
    expect(input.value).toBe("");
    const label = host!.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent).toBe("Image link (https://…)");
  });

  it("shows a link somebody typed, and not an uploaded picture", async () => {
    await mount("https://example.com/me.png");
    expect((await openLink()).value).toBe("https://example.com/me.png");
    act(() => root?.unmount());
    host?.remove();
    await mount("/api/avatars/abc");
    expect((await openLink()).value).toBe("");
  });

  it("asks the caller to save on Enter, but not while composing", async () => {
    await mount();
    const input = await openLink();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
