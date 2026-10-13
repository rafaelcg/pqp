// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockedShareError, showsDockedShareError } from "./docked-share-error";

/**
 * PQP-31, question 2: with nothing on stage the call is only the docked bar,
 * and a share that failed to start used to close the picker and show nothing.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe("showsDockedShareError", () => {
  const failed = { error: "nada foi compartilhado", screenShareError: "nada foi compartilhado" };

  it("shows the share error in the docked bar when nothing is on stage", () => {
    expect(showsDockedShareError(true, failed)).toBe(true);
  });

  it("leaves it to the stage strip when the stage is showing", () => {
    expect(showsDockedShareError(false, failed)).toBe(false);
  });

  it("hides once the error is cleared or replaced by another one", () => {
    expect(showsDockedShareError(true, { ...failed, error: null })).toBe(false);
    expect(showsDockedShareError(true, { ...failed, error: "mic failed" })).toBe(false);
  });

  it("never shows an error that did not come from a share", () => {
    expect(showsDockedShareError(true, { error: "mic failed", screenShareError: null })).toBe(false);
  });
});

describe("DockedShareError", () => {
  it("shows the message and the share-without-sound button when sound killed the share", () => {
    const onShareWithoutSound = vi.fn();
    const el = mount(
      <DockedShareError
        message="nada foi compartilhado"
        audioFailed
        onShareWithoutSound={onShareWithoutSound}
      />,
    );
    const row = el.querySelector("[data-voice-docked-share-error]");
    expect(row?.getAttribute("role")).toBe("alert");
    expect(row?.textContent).toContain("nada foi compartilhado");
    const button = el.querySelector<HTMLButtonElement>("[data-voice-error-share-silent]");
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onShareWithoutSound).toHaveBeenCalledTimes(1);
  });

  it("shows only the message when sound was not the cause", () => {
    const el = mount(
      <DockedShareError message="share blocked" audioFailed={false} onShareWithoutSound={() => {}} />,
    );
    expect(el.textContent).toContain("share blocked");
    expect(el.querySelector("[data-voice-error-share-silent]")).toBeNull();
  });
});
