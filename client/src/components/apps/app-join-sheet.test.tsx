// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppJoinSheet, type AppJoinSheetProps } from "./app-join-sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function props(over: Partial<AppJoinSheetProps> = {}): AppJoinSheetProps {
  return {
    open: true,
    face: "ask",
    app: { name: "Sala de jogos", icon: "gamepad", notice: "Teu jogo fica no teu computador." },
    starterName: "bia",
    countLine: "3 dentro, cabem 4",
    viewer: { name: "rafa", avatarUrl: null },
    asksForId: false,
    identityChecked: false,
    onIdentityChange: () => {},
    failure: "connection",
    canWatch: true,
    fullLine: "4 de 4 jogando. 2 assistindo.",
    endedLine: null,
    onEnter: () => {},
    onWatch: () => {},
    onClose: () => {},
    ...over,
  };
}

function render(p: AppJoinSheetProps) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<AppJoinSheet {...p} />));
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (pattern: RegExp) =>
  Array.from(dialog().querySelectorAll("button")).find((b) => pattern.test(b.textContent ?? ""))!;

describe("AppJoinSheet", () => {
  it("is a modal dialog named by its title, with the two fixed lines and the app's notice", () => {
    render(props());
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().getAttribute("aria-labelledby")).toBeTruthy();
    const text = dialog().textContent ?? "";
    expect(text).toMatch(/Sala de jogos/);
    expect(text).toMatch(/O app vê|The app sees/);
    expect(text).toMatch(/O app não vê|The app does not see/);
    expect(text).toMatch(/Teu jogo fica no teu computador/);
    expect(dialog().querySelectorAll("ul li").length).toBe(3);
  });

  it("adds the device line only for an app that keeps things on the device, between the two fixed lines", () => {
    render(props({ keepsOnDevice: true }));
    expect(dialog().querySelectorAll("ul li").length).toBe(4);
    const items = Array.from(dialog().querySelectorAll("ul li")).map((li) => li.textContent ?? "");
    expect(items[1]).toMatch(/Guarda coisas neste aparelho|Keeps things on this device/);
    expect(items[0]).toMatch(/O app vê|The app sees/);
    expect(items[2]).toMatch(/O app não vê|The app does not see/);
    act(() => root!.unmount());
    host?.remove();
    render(props({ keepsOnDevice: false }));
    expect(dialog().textContent ?? "").not.toMatch(/neste aparelho|on this device/);
  });

  it("shows who started it and how many are in", () => {
    render(props());
    const described = document.getElementById(dialog().getAttribute("aria-describedby")!)!;
    expect(described.textContent).toMatch(/bia/);
    expect(described.textContent).toMatch(/3 dentro, cabem 4/);
  });

  it("has no id box unless the app asks for the id, and it starts unticked", () => {
    render(props());
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    act(() => root!.unmount());
    host?.remove();
    const onIdentityChange = vi.fn();
    render(props({ asksForId: true, onIdentityChange }));
    const box = dialog().querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box.getAttribute("aria-checked")).toBe("false");
    act(() => box.click());
    expect(onIdentityChange).toHaveBeenCalledWith(true);
  });

  it("Entrar, Agora não and the protect link are in the mock's tab order", () => {
    render(props({ asksForId: true }));
    const order = Array.from(dialog().querySelectorAll("button, [role=checkbox]")).map(
      (el) => el.textContent?.trim() ?? "",
    );
    const at = (pattern: RegExp) => order.findIndex((label) => pattern.test(label));
    expect(at(/Deixar este app|Let this app/)).toBeLessThan(at(/Agora não|Not now/));
    expect(at(/Agora não|Not now/)).toBeLessThan(at(/^(Entrar|Join)$/));
    expect(at(/^(Entrar|Join)$/)).toBeLessThan(at(/Como o pqp protege|How pqp protects/));
  });

  it("Entrar enters and Agora não closes", () => {
    const onEnter = vi.fn();
    const onClose = vi.fn();
    render(props({ onEnter, onClose }));
    act(() => button(/^(Entrar|Join)$/).click());
    act(() => button(/Agora não|Not now/).click());
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("entering locks both buttons, marks busy and cannot be dismissed", () => {
    const onClose = vi.fn();
    render(props({ face: "entering", onClose }));
    const enter = button(/Entrando|Joining/);
    expect(enter.getAttribute("aria-busy")).toBe("true");
    expect((enter as HTMLButtonElement).disabled).toBe(true);
    expect((button(/Agora não|Not now/) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog().querySelector('[aria-label="Fechar diálogo"], [aria-label="Close dialog"]')).toBeNull();
    expect(dialog().textContent).toMatch(/Abrindo a sala|Opening the room/);
  });

  it("a failure is an alert on top and the same button says Tentar de novo", () => {
    render(props({ face: "failed", failure: "connection" }));
    const alert = dialog().querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/conexão|connection/);
    expect(button(/Tentar de novo|Try again/)).toBeTruthy();
    expect((button(/Tentar de novo|Try again/) as HTMLButtonElement).disabled).toBe(false);
  });

  it("each failure has its own sentence", () => {
    const sentence = (failure: AppJoinSheetProps["failure"]) => {
      render(props({ face: "failed", failure }));
      const text = dialog().querySelector('[role="alert"]')!.textContent;
      act(() => root!.unmount());
      host?.remove();
      return text;
    };
    const seen = new Set(
      (["connection", "not-allowed", "rate-limited", "unavailable"] as const).map(sentence),
    );
    expect(seen.size).toBe(4);
  });

  it("a full room offers Assistir when the app admits spectators, and only Agora não otherwise", () => {
    const onWatch = vi.fn();
    render(props({ face: "full", onWatch }));
    expect(dialog().textContent).toMatch(/encheu|filled/);
    act(() => button(/Assistir|Watch/).click());
    expect(onWatch).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    host?.remove();
    render(props({ face: "full", canWatch: false }));
    expect(Array.from(dialog().querySelectorAll("button")).some((b) => /Assistir|Watch/.test(b.textContent ?? ""))).toBe(false);
  });

  it("an ended session and a switched-off app are quiet: a status and Fechar", () => {
    const onClose = vi.fn();
    render(props({ face: "ended", endedLine: "bia encerrou Sala de jogos há 1 min.", onClose }));
    expect(dialog().textContent).toMatch(/já terminou|already ended/);
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    expect(dialog().querySelector('[role="checkbox"]')).toBeNull();
    act(() => button(/Fechar|Close/).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root!.unmount());
    host?.remove();
    render(props({ face: "disabled" }));
    expect(dialog().textContent).toMatch(/não está disponível|not available/);
  });

  it("the protect link opens a short explanation and says it is expanded", () => {
    render(props());
    const link = button(/Como o pqp protege|How pqp protects/);
    const target = document.getElementById(link.getAttribute("aria-controls")!)!;
    expect(link.getAttribute("aria-expanded")).toBe("false");
    expect(target.hidden).toBe(true);
    act(() => link.click());
    expect(link.getAttribute("aria-expanded")).toBe("true");
    expect(target.hidden).toBe(false);
  });
});
