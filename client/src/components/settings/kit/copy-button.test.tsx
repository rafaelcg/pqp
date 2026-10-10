// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsBuildLine } from "@/components/settings/kit/build-line";
import {
  SETTINGS_COPIED_MS,
  SettingsCopyButton,
} from "@/components/settings/kit/copy-button";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let writeText: ReturnType<typeof vi.fn>;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TooltipProvider>{node}</TooltipProvider>));
}

function button(): HTMLButtonElement {
  return host!.querySelector("button")!;
}

function liveText(): string {
  return host!.querySelector('[role="status"]')?.textContent ?? "";
}

async function click() {
  await act(async () => {
    button().click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("SettingsCopyButton", () => {
  it("copies, shows the check and announces, then goes back", async () => {
    mount(<SettingsCopyButton text="contato@pqp.gg" label="Copiar endereço" copiedLabel="Copiado" />);
    expect(button().getAttribute("aria-label")).toBe("Copiar endereço");
    expect(liveText()).toBe("");

    await click();
    expect(writeText).toHaveBeenCalledWith("contato@pqp.gg");
    expect(liveText()).toBe("Copiado");
    expect(button().querySelector(".lucide-check")).not.toBeNull();

    act(() => vi.advanceTimersByTime(SETTINGS_COPIED_MS));
    expect(liveText()).toBe("");
    expect(button().querySelector(".lucide-copy")).not.toBeNull();
  });

  it("restarts the clock on a second copy", async () => {
    mount(<SettingsCopyButton text="x" label="Copiar" copiedLabel="Copiado" />);
    await click();
    act(() => vi.advanceTimersByTime(SETTINGS_COPIED_MS - 200));
    await click();
    act(() => vi.advanceTimersByTime(SETTINGS_COPIED_MS - 200));
    expect(liveText()).toBe("Copiado");
    act(() => vi.advanceTimersByTime(200));
    expect(liveText()).toBe("");
  });

  it("says so when nothing can copy, instead of doing nothing", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    mount(<SettingsCopyButton text="x" label="Copiar" copiedLabel="Copiado" />);
    await click();
    expect(liveText()).toMatch(/Não deu pra copiar|Couldn't copy/);
    expect(button().querySelector(".lucide-circle-x")).not.toBeNull();
  });

  it("falls back to the old copy when the clipboard refuses", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    mount(<SettingsCopyButton text="x" label="Copiar" copiedLabel="Copiado" />);
    await click();
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(liveText()).toBe("Copiado");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("shows its label as text with showLabel, and swaps it after a copy", async () => {
    mount(
      <SettingsCopyButton
        text="https://pqp.gg/@rafa"
        label="Copiar link"
        copiedLabel="Link copiado"
        showLabel
      />,
    );
    expect(button().textContent).toBe("Copiar link");
    await click();
    expect(button().textContent).toBe("Link copiado");
  });
});

describe("SettingsBuildLine", () => {
  it("shows the row's line as selectable text next to a copy button", async () => {
    mount(<SettingsBuildLine variant="row" />);
    const text = host!.querySelector("[data-build-line]")!;
    expect(text.className).toContain("font-mono");
    expect(text.className).toContain("select-all");
    expect(button().getAttribute("aria-label")).toMatch(/^(Copiar versão|Copy version): pqp /);
    await click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]![0])).toMatch(/^pqp (web|desktop) · /);
    act(() => vi.advanceTimersByTime(SETTINGS_COPIED_MS));
    expect(liveText()).toBe("");
  });
});

describe("SettingsBuildLine without a clipboard", () => {
  it("says it could not copy and selects the line for the person", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    for (const variant of ["rail", "row"] as const) {
      mount(<SettingsBuildLine variant={variant} />);
      await click();
      const message = host!.querySelector("[data-copy-failed]");
      expect(message?.textContent).toMatch(/Não deu pra copiar|Couldn't copy/);
      expect(window.getSelection()?.toString()).toMatch(/^pqp (web|desktop) · /);
      act(() => root?.unmount());
      host?.remove();
      root = null;
    }
  });
});
