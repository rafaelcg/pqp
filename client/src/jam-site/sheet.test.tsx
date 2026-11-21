// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AskProvider, useAsk } from "./auth-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom has no modal dialog, so this is one that behaves like the browser's for
 * what the Sheet depends on: `showModal` / `close` toggle `open`, and `close()`
 * fires `close`. How a person dismisses it is modelled by the helpers below.
 */
beforeAll(() => {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

/**
 * Escape and the Android back gesture as Chrome runs them (measured on Chrome 158, a
 * bare dialog): a `cancel` event, the dialog closes, a `toggle` event, and NO `close`
 * event. The old Sheet listened for `close` only and never heard it.
 */
function dismissLikeChrome(dialog: HTMLDialogElement): boolean {
  const cancel = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  if (cancel.defaultPrevented) return false;
  dialog.removeAttribute("open");
  dialog.dispatchEvent(new Event("toggle"));
  return true;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Opener({ kind }: { kind: "like" | "record" | "start" }) {
  const ask = useAsk();
  return (
    <button type="button" data-opener={kind} onClick={() => ask({ kind, songId: "s1" })}>
      open {kind}
    </button>
  );
}

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AskProvider>
        <Opener kind="like" />
        <Opener kind="record" />
        <Opener kind="start" />
      </AskProvider>,
    ),
  );
  return {
    dialog: host.querySelector<HTMLDialogElement>("dialog[data-jam-sheet]")!,
    press: (kind: string) => act(() => host!.querySelector<HTMLButtonElement>(`[data-opener="${kind}"]`)!.click()),
    settle: () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5))),
  };
}

describe("the sign-up sheet", () => {
  it("opens again after it was dismissed with Escape (the dead button)", async () => {
    const { dialog, press, settle } = mount();
    press("like");
    expect(dialog.open).toBe(true);

    expect(dismissLikeChrome(dialog)).toBe(true);
    await settle();
    expect(dialog.open).toBe(false);

    // The same button, then another one, both must open the sheet.
    press("like");
    expect(dialog.open).toBe(true);
    dismissLikeChrome(dialog);
    await settle();
    press("record");
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("record");
  });

  it("opens again after the browser closed it with a bare close event", async () => {
    const { dialog, press, settle } = mount();
    press("start");
    expect(dialog.open).toBe(true);
    act(() => dialog.close());
    await settle();
    press("start");
    expect(dialog.open).toBe(true);
  });

  it("opens again after the X, and after a click on the backdrop", async () => {
    const { dialog, press, settle } = mount();
    press("like");
    act(() => dialog.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    expect(dialog.open).toBe(false);
    press("like");
    expect(dialog.open).toBe(true);
    act(() => dialog.click());
    await settle();
    expect(dialog.open).toBe(false);
    press("like");
    expect(dialog.open).toBe(true);
  });

  it("stays open when a dismissal is prevented", async () => {
    const { dialog, press, settle } = mount();
    press("like");
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    expect(dismissLikeChrome(dialog)).toBe(false);
    await settle();
    expect(dialog.open).toBe(true);
    // And it did not tell the owner it had closed: the content is still there.
    expect(dialog.querySelector("h2")).not.toBeNull();
  });

  it("opens when asked while the owner still believes it is open", async () => {
    const { dialog, press } = mount();
    press("like");
    // Closed behind the owner's back, with no event at all.
    dialog.removeAttribute("open");
    press("like");
    expect(dialog.open).toBe(true);
  });
});
