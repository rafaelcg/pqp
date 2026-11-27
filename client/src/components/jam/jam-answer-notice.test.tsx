// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { JAM_ANSWER_MS, JAM_ANSWER_UNDONE_MS, JamAnswerNotice, type JamAnswer } from "./jam-answer-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The name is isolated for bidi text (`isolate`): the marks are invisible, not part of what is read. */
const plain = (text: string | null | undefined) => (text ?? "").replace(/[\u2066-\u2069]/g, "");

let host: HTMLDivElement;
let root: Root;

const answer = (over: Partial<JamAnswer> = {}): JamAnswer => ({
  kind: "accepted",
  trackId: "t1",
  instrument: "guitar",
  name: "Joana",
  ...over,
});

function mount(value: JamAnswer, handlers: { onUndo?: () => void; onDismiss?: () => void } = {}) {
  const onUndo = handlers.onUndo ?? vi.fn();
  const onDismiss = handlers.onDismiss ?? vi.fn();
  act(() => {
    root.render(
      <I18nProvider>
        <JamAnswerNotice answer={value} onUndo={onUndo} onDismiss={onDismiss} />
      </I18nProvider>,
    );
  });
  return { onUndo, onDismiss };
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("what the starter is told after answering a part (round 3, n-1)", () => {
  it("after Aceitar it says what became of the part and what people see, and offers to undo it", () => {
    const { onUndo } = mount(answer());
    const box = host.querySelector("[data-jam-answered]")!;
    expect(box.getAttribute("data-jam-answered")).toBe("accepted");
    expect(box.getAttribute("role")).toBe("status");
    expect(plain(box.textContent)).toContain("Joana's guitar is in the song");
    expect(box.textContent).toContain("shows for anyone who opens it");
    act(() => host.querySelector<HTMLButtonElement>("[data-jam-answered-undo]")!.click());
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("after Recusar it says the sender is told, and there is nothing to undo (a declined take is deleted)", () => {
    mount(answer({ kind: "refused" }));
    expect(host.textContent).toContain("Part declined");
    expect(plain(host.textContent)).toContain("Joana is told");
    expect(host.querySelector("[data-jam-answered-undo]")).toBeNull();
  });

  it("after the undo it says the part is back in the queue", () => {
    mount(answer({ kind: "undone" }));
    expect(host.textContent).toContain("Back in the queue");
    expect(host.querySelector("[data-jam-answered-undo]")).toBeNull();
  });

  it("an unnamed sender is named as anonymous, never as nothing", () => {
    mount(answer({ name: null }));
    expect(host.textContent).not.toContain("undefined");
    expect(host.textContent).not.toMatch(/ 's |^'s /);
  });

  it("goes away by itself, and the undo is offered for exactly as long as the box stays", () => {
    const { onDismiss } = mount(answer());
    act(() => {
      vi.advanceTimersByTime(JAM_ANSWER_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the confirmation of an undo is shorter, and a re-render does not start the clock over", () => {
    const onDismiss = vi.fn();
    mount(answer({ kind: "undone" }), { onDismiss });
    act(() => {
      vi.advanceTimersByTime(JAM_ANSWER_UNDONE_MS - 100);
    });
    mount(answer({ kind: "undone" }), { onDismiss });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("the X closes it at once", () => {
    const { onDismiss } = mount(answer());
    act(() => host.querySelector<HTMLButtonElement>("[data-jam-answered-close]")!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
