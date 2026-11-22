// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_MAX_LENGTH } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetRedesignForTests, setRedesignChoice } from "@/lib/redesign";

vi.mock("@/lib/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/attachments")>();
  return {
    ...actual,
    loadAttachmentConfig: () => Promise.resolve({ enabled: true, maxBytes: 10 * 1024 * 1024 }),
  };
});

import { MessageComposer } from "./message-composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  localStorage.clear();
  resetRedesignForTests();
  delete document.documentElement.dataset.redesign;
});

function type(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function paste(input: HTMLTextAreaElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text, items: [], files: [], types: ["text/plain"] },
  });
  input.dispatchEvent(event);
  // jsdom does not insert pasted text, so do what the browser would.
  type(input, input.value + text);
}

describe("composer paste undo", () => {
  it("drops the undo offer once the person keeps typing after the paste", async () => {
    setRedesignChoice(true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <TooltipProvider>
          <MessageComposer onSend={() => {}} channelId="11111111-1111-4111-8111-111111111111" />
        </TooltipProvider>,
      );
    });
    const input = host.querySelector("textarea")!;
    await act(async () => {
      type(input, "oi ");
    });
    await act(async () => {
      paste(input, "x".repeat(MESSAGE_MAX_LENGTH + 10));
    });
    expect(host.querySelector("[data-composer-paste-offer]")).not.toBeNull();

    await act(async () => {
      type(input, input.value + "y");
    });
    expect(host.querySelector("[data-composer-paste-offer]")).toBeNull();
  });
});
