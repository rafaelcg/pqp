// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "@/lib/connection-doctor";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * The connection check as a dialog. It runs on open, and again only when the
 * person asks. A parent that hands in a new token getter on every render (App
 * did, an inline arrow) must not restart it: a run is a few seconds of probing
 * the network, announced from the top each time.
 */

const REPORT: DoctorReport = { results: [], advice: "none", at: "now" };
const runConnectionChecks = vi.fn(
  async (_input: unknown): Promise<DoctorReport> => REPORT,
);

vi.mock("@/lib/connection-doctor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connection-doctor")>()),
  runConnectionChecks: (input: unknown) => runConnectionChecks(input),
}));

const { ConnectionDoctorDialog } = await import("./connection-doctor-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const transport = {} as RealtimeTransport;

function render(getToken: () => Promise<string | null>, open = true) {
  return act(async () => {
    root!.render(
      <ConnectionDoctorDialog
        open={open}
        onClose={() => undefined}
        transport={transport}
        getToken={getToken}
        onSignInAgain={() => undefined}
        appVersion="test"
      />,
    );
  });
}

beforeEach(() => {
  runConnectionChecks.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function runButton(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    /Run again|Test again|Testar de novo|Probar de nuevo|Check again|Running|Testando|Probando/i.test(
      b.textContent ?? "",
    ),
  )!;
}

describe("ConnectionDoctorDialog", () => {
  it("runs once on open, and not again when the parent hands in a new token getter", async () => {
    await render(async () => "a");
    expect(runConnectionChecks).toHaveBeenCalledTimes(1);
    await render(async () => "b");
    await render(async () => "c");
    expect(runConnectionChecks).toHaveBeenCalledTimes(1);
  });

  it("asks the latest token getter when a check needs the token", async () => {
    await render(async () => "old");
    await render(async () => "new");
    const input = runConnectionChecks.mock.calls[0]![0] as {
      getToken: () => Promise<string | null>;
    };
    expect(await input.getToken()).toBe("new");
  });

  it("runs again when the person asks, and keeps focus on the button they pressed", async () => {
    let finish: (report: DoctorReport) => void = () => undefined;
    await render(async () => "a");
    expect(runConnectionChecks).toHaveBeenCalledTimes(1);

    runConnectionChecks.mockImplementationOnce(
      () => new Promise<DoctorReport>((resolve) => (finish = resolve)),
    );
    const button = runButton();
    button.focus();
    await act(async () => {
      button.click();
    });
    expect(runConnectionChecks).toHaveBeenCalledTimes(2);
    // Running: busy, but still the focused element, not a disabled one.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);

    // A second press while it runs starts nothing.
    await act(async () => {
      button.click();
    });
    expect(runConnectionChecks).toHaveBeenCalledTimes(2);

    await act(async () => {
      finish(REPORT);
    });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
