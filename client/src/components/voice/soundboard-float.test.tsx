// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SoundboardFloat } from "./soundboard-float";
import { resetSoundboardMarksForTests, showSoundboardMark } from "@/lib/soundboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetSoundboardMarksForTests();
});

describe("SoundboardFloat", () => {
  it("announces who played which sound", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root!.render(<SoundboardFloat userId="u1" />);
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => {
      showSoundboardMark({
        userId: "u1",
        displayName: "Rafa",
        emoji: "📣",
        soundId: "builtin:buzina",
      });
    });
    const status = host.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Rafa played Airhorn");
  });
});
