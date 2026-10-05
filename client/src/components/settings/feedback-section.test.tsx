// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_BODY_MAX_LENGTH } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import { resetSettingsRowsForTest } from "@/components/settings/kit/registry";
import { SettingsSectionContext } from "@/components/settings/kit/sections";
import {
  FeedbackSection,
  endFeedbackVisit,
  counterTone,
  feedbackCount,
} from "@/components/settings/feedback-section";

const sendFeedback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  sendFeedback,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const MAX = FEEDBACK_BODY_MAX_LENGTH;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(userId: string | null = null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SettingsSectionContext.Provider value="feedback">
        <FeedbackSection voice={null} userId={userId} />
      </SettingsSectionContext.Provider>,
    ),
  );
}

const textarea = () => host!.querySelector<HTMLTextAreaElement>("textarea")!;
const sendButton = () =>
  [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("role") !== "radio" && !button.hidden,
  )!;
const radios = () => [...host!.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const counter = () => host!.querySelector<HTMLElement>("[data-counter-tone]");

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(init: KeyboardEventInit) {
  act(() => {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** Clear the module-level draft the section keeps between mounts. */
function clearDraft() {
  mount();
  radios()[0]!.click();
  type("");
  act(() => root?.unmount());
  host?.remove();
}

beforeEach(() => {
  sendFeedback.mockReset();
  resetSettingsRowsForTest();
  clearDraft();
  resetSettingsRowsForTest();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("counter helpers", () => {
  it("counts a box of whitespace as empty", () => {
    expect(feedbackCount("       ")).toBe(0);
    expect(feedbackCount("\n\n")).toBe(0);
    expect(feedbackCount("  oi ")).toBe(5);
  });

  it("turns amber from 90% and red at the limit", () => {
    expect(counterTone(0, MAX)).toBe("");
    expect(counterTone(MAX * 0.9 - 1, MAX)).toBe("");
    expect(counterTone(MAX * 0.9, MAX)).toBe("warn");
    expect(counterTone(MAX - 1, MAX)).toBe("warn");
    expect(counterTone(MAX, MAX)).toBe("full");
  });
});

describe("FeedbackSection", () => {
  it("explains why Enviar is off and drops the explanation once there is text", () => {
    mount();
    const send = sendButton();
    expect(send.disabled).toBe(true);
    const noteId = send.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    const note = host!.querySelector<HTMLElement>(`[id="${noteId}"]`)!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).not.toBe("");

    type("   \n  ");
    expect(sendButton().disabled).toBe(true);
    expect(host!.textContent).toContain("0 / 2000");

    type("o áudio some");
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();
    expect(note.hidden).toBe(true);
  });

  it("recolours the counter at 90% and at the limit, and cuts the border to danger", () => {
    mount();
    type("a".repeat(100));
    expect(counter()).toBeNull();

    type("a".repeat(MAX * 0.9));
    expect(counter()!.getAttribute("data-counter-tone")).toBe("warn");
    expect(host!.textContent).toContain("200");
    expect(textarea().className).not.toContain("border-danger");

    type("a".repeat(MAX));
    expect(counter()!.getAttribute("data-counter-tone")).toBe("full");
    expect(host!.textContent).toContain(String(MAX));
    expect(textarea().className).toContain("border-danger");
  });

  it("announces the count through a live region that settles after typing", () => {
    vi.useFakeTimers();
    mount();
    const live = host!.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(live).not.toBeNull();
    type("abc");
    // Not announced on every key.
    expect(live.textContent).toContain("0 / 2000");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(live.textContent).toContain("3 / 2000");
  });

  it("shows a hint under the chosen kind", () => {
    mount();
    const hint = () => host!.querySelector<HTMLElement>("p.text-text-tertiary.flex")!;
    const bug = hint().textContent;
    act(() => radios()[2]!.click());
    expect(hint().textContent).not.toBe(bug);
    act(() => radios()[1]!.click());
    const idea = hint().textContent;
    expect(idea).not.toBe(bug);
    act(() => radios()[0]!.click());
    expect(hint().textContent).toBe(bug);
  });

  it("sends with Ctrl+Enter and Cmd+Enter once there is text, and not before", async () => {
    sendFeedback.mockResolvedValue({});
    mount();
    press({ key: "Enter", ctrlKey: true });
    expect(sendFeedback).not.toHaveBeenCalled();

    type("  algo quebrou  ");
    // Plain Enter is a line break, not a send.
    press({ key: "Enter" });
    expect(sendFeedback).not.toHaveBeenCalled();

    await act(async () => {
      press({ key: "Enter", metaKey: true });
      await Promise.resolve();
    });
    expect(sendFeedback).toHaveBeenCalledTimes(1);
    expect(sendFeedback.mock.calls[0]![0]).toMatchObject({
      kind: "bug",
      body: "algo quebrou",
    });
  });

  it("does not send twice while the first send is in flight", async () => {
    let finish!: () => void;
    sendFeedback.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount();
    type("oi");
    await act(async () => {
      press({ key: "Enter", ctrlKey: true });
      await Promise.resolve();
    });
    await act(async () => {
      press({ key: "Enter", ctrlKey: true });
      await Promise.resolve();
    });
    expect(sendFeedback).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });

  it("keeps the text and says so when the send fails", async () => {
    sendFeedback.mockRejectedValue(new Error("network"));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    const alert = host!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("Couldn't send. Your text is still here, try again in a moment.");
    expect(textarea().value).toBe("meu relato");
  });

  it("gives a rate limit its own message", async () => {
    sendFeedback.mockRejectedValue(new ApiError(429, "slow down"));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe(
      "You sent a lot in a row. Wait a minute and try again.",
    );
  });

  it("puts the kind back on Bug for the next report", async () => {
    sendFeedback.mockResolvedValue({});
    mount();
    act(() => radios()[2]!.click());
    expect(radios()[2]!.getAttribute("aria-checked")).toBe("true");
    type("uma dúvida");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    expect(host!.querySelector("textarea")).toBeNull();
    expect(host!.textContent).toContain("We read everything");

    const again = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "Send another",
    )!;
    act(() => again.click());
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(radios()[2]!.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the draft in sessionStorage, so a reload for a language change keeps it", () => {
    mount("user-a");
    type("relato longo");
    expect(JSON.parse(sessionStorage.getItem("pqp:feedback-draft")!)).toMatchObject({
      owner: "user-a",
      body: "relato longo",
    });
  });

  it("comes back mid-send as sending, not as a second Enviar", async () => {
    let finish!: () => void;
    sendFeedback.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    act(() => root?.unmount());
    host?.remove();

    mount();
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    expect(sendFeedback).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host!.textContent).toContain("We read everything");
  });

  it("shows the thanks when the send finished while the pane was away", async () => {
    let finish!: () => void;
    sendFeedback.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    act(() => root?.unmount());
    host?.remove();
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    mount();
    expect(host!.textContent).toContain("We read everything");
  });

  it("shows the form, not an old thanks, once Settings was closed in between", async () => {
    let finish!: () => void;
    sendFeedback.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    act(() => root?.unmount());
    host?.remove();
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    endFeedbackVisit();

    mount();
    expect(host!.textContent).not.toContain("We read everything");
    expect(textarea().value).toBe("");
  });

  it("says a send failed on the next open when it failed after Settings closed", async () => {
    let fail!: (error: unknown) => void;
    sendFeedback.mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    act(() => root?.unmount());
    host?.remove();
    endFeedbackVisit();
    await act(async () => {
      fail(new Error("network"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    endFeedbackVisit();

    mount();
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't send. Your text is still here, try again in a moment.",
    );
    expect(textarea().value).toBe("meu relato");
  });

  it("does not carry a rate limit over to a later visit", async () => {
    let fail!: (error: unknown) => void;
    sendFeedback.mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
    mount();
    type("meu relato");
    await act(async () => {
      sendButton().click();
      await Promise.resolve();
    });
    act(() => root?.unmount());
    host?.remove();
    await act(async () => {
      fail(new ApiError(429, "slow down"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    endFeedbackVisit();

    mount();
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(textarea().value).toBe("meu relato");
  });

  it("keeps a draft for the same account and drops it for another", () => {
    mount("user-a");
    type("relato privado da conta A");
    act(() => root?.unmount());
    host?.remove();

    mount("user-a");
    expect(textarea().value).toBe("relato privado da conta A");
    act(() => root?.unmount());
    host?.remove();

    mount("user-b");
    expect(textarea().value).toBe("");
  });
});
