// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetRedesignForTests, setRedesignChoice } from "@/lib/redesign";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    createReport: () =>
      Promise.resolve({ report: { reason: "spam", subjectType: "user", contextKind: "server" } }),
  };
});

import { ReportDialog } from "./report-dialog";

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

function button(label: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].filter((node) =>
    label.test(node.textContent ?? ""),
  );
  if (found.length === 0) {
    throw new Error(`no button matching ${label}`);
  }
  return found[found.length - 1];
}

async function fileAndBlock(onBlock: (userId: string) => Promise<boolean>) {
  setRedesignChoice(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <ReportDialog
          target={{ kind: "user", userId: "u1", subjectName: "Rafa", serverId: "s1" }}
          onClose={() => {}}
          onBlock={onBlock}
        />
      </TooltipProvider>,
    );
  });
  await act(async () => {
    document.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
  });
  await act(async () => {
    button(/^(Send|Report|Enviar|Denunciar)/i).click();
  });
  await act(async () => {
    button(/Rafa/).click();
  });
  await act(async () => {
    button(/^Block$/i).click();
  });
}

describe("report dialog block", () => {
  it("says blocked only once the block landed", async () => {
    await fileAndBlock(() => Promise.resolve(true));
    expect(document.querySelector('[data-report-sent] [role="status"]')?.textContent).toContain("Rafa");
    expect(document.querySelector('[data-report-sent] [role="alert"]')).toBeNull();
  });

  it("keeps the button and says it failed when the block did not land", async () => {
    await fileAndBlock(() => Promise.resolve(false));
    expect(document.querySelector('[data-report-sent] [role="status"]')).toBeNull();
    expect(document.querySelector('[data-report-sent] [role="alert"]')).not.toBeNull();
    expect(button(/Rafa/).disabled).toBe(false);
  });
});
