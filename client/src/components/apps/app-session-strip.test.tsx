// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardPerson } from "@/lib/apps/card-model";
import type { EndedStripModel, LiveStripModel } from "@/lib/apps/strip-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AppSessionStrip,
  endedLineText,
  type AppSessionStripProps,
  type StripShareState,
} from "./app-session-strip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const people = (names: string[]): CardPerson[] =>
  names.map((name) => ({ userId: `id-${name}`, displayName: name, avatarUrl: null }));

function live(over: Partial<LiveStripModel> = {}): LiveStripModel {
  return {
    kind: "live",
    sessionId: "s1",
    app: { id: "pqp-eco", name: "Sala de jogos", icon: "gamepad" },
    phase: "participant",
    tone: "normal",
    line: { kind: "hostIs", name: "bia" },
    people: people(["bia", "leo", "duda"]),
    more: 0,
    count: { kind: "of", players: 3, max: 4, watching: 0 },
    roster: [
      { userId: "id-bia", name: "bia", avatarUrl: null, host: true, spectator: false, reconnecting: false },
      { userId: "id-leo", name: "leo", avatarUrl: null, host: false, spectator: false, reconnecting: false },
    ],
    seated: true,
    isHost: false,
    spectating: false,
    showPane: true,
    actions: { leave: true, end: false, enter: null, takeHost: false, share: false },
    ...over,
  };
}

function ended(over: Partial<EndedStripModel> = {}): EndedStripModel {
  return {
    kind: "ended",
    sessionId: "s1",
    app: { id: "pqp-eco", name: "Sala de jogos", icon: "gamepad" },
    disabled: false,
    cause: { kind: "host", name: "bia", self: false },
    summary: { participants: 4, durationSeconds: 23 * 60 },
    ...over,
  };
}

function render(props: AppSessionStripProps) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<TooltipProvider><AppSessionStrip {...props} /></TooltipProvider>));
  return host;
}

const shareOff: StripShareState = {
  visible: true,
  on: false,
  pending: false,
  needsCall: false,
  viewers: 0,
  wholeTab: false,
};

const buttons = () => Array.from(document.querySelectorAll("button"));
const byText = (text: string) => buttons().find((button) => button.textContent?.trim() === text);

describe("AppSessionStrip", () => {
  it("is a labelled region, before the app, with a skip link first", () => {
    render({ model: live() });
    const region = document.querySelector('[role="region"]')!;
    expect(region.getAttribute("aria-label")).toMatch(/Sala de jogos/);
    expect(region.querySelector("button")?.textContent).toMatch(/app/i);
  });

  it("a participant sees Sair and a menu, and no Encerrar, no share switch", () => {
    render({ model: live() });
    expect(byText("Sair do app") ?? byText("Leave app")).toBeTruthy();
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(buttons().some((b) => /Encerrar|End/.test(b.textContent ?? ""))).toBe(false);
    expect(document.querySelector('button[aria-label]')).not.toBeNull();
  });

  it("the host sees the switch then Encerrar (Sair moves to the menu), and Encerrar asks first", () => {
    const onEnd = vi.fn();
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: shareOff,
      onEnd,
    });
    const order = Array.from(document.querySelectorAll('[role="switch"], button'))
      .map((el) => (el.getAttribute("role") === "switch" ? "switch" : el.textContent?.trim()))
      .filter((label) => label === "switch" || /^(Sair do app|Leave app|Encerrar app|End app)$/.test(label ?? ""));
    // One primary button: whoever may end it finds Sair under the menu.
    expect(order).toEqual(["switch", order[1]]);
    expect(order[1]).toMatch(/Encerrar app|End app/);
    expect(
      buttons().some((b) => /^(Mais|More)/.test(b.getAttribute("aria-label") ?? "")),
    ).toBe(true);

    const end = buttons().find((b) => /^(Encerrar app|End app)$/.test(b.textContent?.trim() ?? ""))!;
    act(() => end.click());
    expect(onEnd).not.toHaveBeenCalled();
    const confirm = document.querySelector('[role="dialog"]')!;
    expect(confirm).toBeTruthy();
    const yes = Array.from(confirm.querySelectorAll("button")).find((b) =>
      /^(Encerrar app|End app)$/.test(b.textContent?.trim() ?? ""),
    )!;
    act(() => yes.click());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("the share switch is a switch with a checked state, and the badge says how many see it", () => {
    const onShareChange = vi.fn();
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: { ...shareOff, on: true, viewers: 7 },
      onShareChange,
    });
    const toggle = document.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/7/);
    act(() => toggle.click());
    expect(onShareChange).toHaveBeenCalledWith(false);
  });

  it("sharing with nobody watching says Compartilhando, never pra 0", () => {
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: { ...shareOff, on: true, viewers: 0 },
    });
    const chip = document.querySelector('[data-testid="app-strip-sharing"]')!;
    expect(chip.textContent).toMatch(/^(Compartilhando|Sharing)$/);
    expect(chip.textContent).not.toMatch(/0/);
  });

  it("not in the call with a way to join: one click on Entrar na call joins, no switch to puzzle over", () => {
    const onJoinCall = vi.fn();
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: { ...shareOff, needsCall: true },
      joinCall: { onJoin: onJoinCall, joining: false },
    });
    expect(document.querySelector('[role="switch"]')).toBeNull();
    const join = document.querySelector<HTMLButtonElement>('[data-testid="app-strip-join-call"]')!;
    expect(join.textContent).toMatch(/Entrar na call|Join the call/);
    act(() => join.click());
    expect(onJoinCall).toHaveBeenCalledTimes(1);
  });

  it("a seated participant who cannot share gets Entrar na call too, and nobody outside the app does", () => {
    const onJoin = vi.fn();
    render({ model: live(), joinCall: { onJoin, joining: false } });
    expect(document.querySelector('[data-testid="app-strip-join-call"]')).not.toBeNull();
    act(() => root!.unmount());
    host!.remove();
    render({ model: live({ seated: false, phase: "outside" }), joinCall: { onJoin, joining: false } });
    expect(document.querySelector('[data-testid="app-strip-join-call"]')).toBeNull();
  });

  it("not in the call: the switch is shown, says why, and does not fire", () => {
    const onShareChange = vi.fn();
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: { ...shareOff, needsCall: true },
      onShareChange,
    });
    const toggle = document.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    act(() => toggle.click());
    expect(onShareChange).not.toHaveBeenCalled();
    // and says why in words beside it, not only in a hover: a dimmed switch with no reason is a button that does nothing
    const reason = document.querySelector('[data-testid="app-strip-share-reason"]')!;
    expect(reason.textContent).toMatch(/call/i);
  });

  it("already sharing another screen: the switch is shown, says so, and does not fire", () => {
    const onShareChange = vi.fn();
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: { ...shareOff, otherShare: true },
      onShareChange,
    });
    const toggle = document.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    act(() => toggle.click());
    expect(onShareChange).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="app-strip-share-reason"]')?.textContent).toMatch(/outra tela|another screen/);
  });

  it("able to share: no reason is drawn and the switch fires", () => {
    const onShareChange = vi.fn();
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
      }),
      share: shareOff,
      onShareChange,
    });
    expect(document.querySelector('[data-testid="app-strip-share-reason"]')).toBeNull();
    const toggle = document.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-disabled")).toBeNull();
    act(() => toggle.click());
    expect(onShareChange).toHaveBeenCalledWith(true);
  });

  it("the next host sees a warm strip and Assumir agora calls the take-over", () => {
    const onTakeHost = vi.fn();
    render({
      model: live({
        phase: "handoff-you",
        tone: "warn",
        line: { kind: "handoffYou", host: "bia", seconds: 108 },
        actions: { leave: true, end: false, enter: null, takeHost: true, share: false },
      }),
      onTakeHost,
    });
    const region = document.querySelector('[role="region"]')!;
    expect(region.className).toMatch(/warning-soft/);
    expect(region.textContent).toMatch(/1:48/);
    const take = buttons().find((b) => /Assumir agora|Take over now/.test(b.textContent ?? ""))!;
    act(() => take.click());
    expect(onTakeHost).toHaveBeenCalledTimes(1);
  });

  it("the countdown is announced at 60, 30 and 10 seconds and not on every tick", () => {
    const model = (seconds: number) =>
      live({
        phase: "handoff-other",
        tone: "warn",
        line: { kind: "handoffOther", host: "bia", next: "leo", seconds },
      });
    render({ model: model(75) });
    const status = () => document.querySelector('[role="status"][aria-live]')!.textContent;
    const rerender = (seconds: number) =>
      act(() => root!.render(<TooltipProvider><AppSessionStrip model={model(seconds)} /></TooltipProvider>));
    expect(status()).toMatch(/1:15/);
    rerender(74);
    expect(status()).toMatch(/1:15/);
    rerender(60);
    expect(status()).toMatch(/1:00/);
    rerender(59);
    expect(status()).toMatch(/1:00/);
  });

  it("reconnecting: the button is a disabled Reconectando and the line says 90 s", () => {
    render({
      model: live({
        phase: "reconnecting",
        tone: "off",
        line: { kind: "reconnecting" },
        actions: { leave: true, end: false, enter: null, takeHost: false, share: false },
      }),
    });
    const button = buttons().find((b) => /Reconectando|Reconnecting/.test(b.textContent ?? ""))!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector('[role="region"]')?.textContent).toMatch(/90 s/);
  });

  it("outside the session the strip offers Entrar, busy while the join is in flight", () => {
    const onJoin = vi.fn();
    render({
      model: live({
        phase: "outside",
        seated: false,
        showPane: false,
        actions: { leave: false, end: false, enter: "join", takeHost: false, share: false },
      }),
      onJoin,
    });
    const join = buttons().find((b) => /^(Entrar|Join)$/.test(b.textContent?.trim() ?? ""))!;
    act(() => join.click());
    expect(onJoin).toHaveBeenCalledWith({ asSpectator: false });
  });

  it("a full room offers Assistir, which joins as a spectator", () => {
    const onJoin = vi.fn();
    render({
      model: live({
        phase: "outside",
        seated: false,
        showPane: false,
        actions: { leave: false, end: false, enter: "watch", takeHost: false, share: false },
      }),
      onJoin,
    });
    act(() => buttons().find((b) => /Assistir|Watch/.test(b.textContent ?? ""))!.click());
    expect(onJoin).toHaveBeenCalledWith({ asSpectator: true });
  });

  it("the ended strip is a status with Fechar, and Fechar closes it", () => {
    const onClose = vi.fn();
    render({ model: ended(), onClose });
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/bia/);
    act(() => buttons().find((b) => /Fechar|Close/.test(b.textContent ?? ""))!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the collapsing class is only on when asked", () => {
    render({ model: ended(), collapsing: true });
    expect(document.querySelector('[role="region"]')?.className).toMatch(/app-strip-out/);
  });

  it("the phone's collapsed bar opens a sheet that keeps focus until closed", () => {
    render({
      model: live({
        phase: "host",
        isHost: true,
        line: { kind: "host" },
        actions: { leave: true, end: true, enter: null, takeHost: false, share: false },
      }),
      compact: true,
    });
    const opener = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    expect(opener.getAttribute("aria-expanded")).toBe("false");
    act(() => opener.click());
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    const sheet = document.querySelector('[role="dialog"]')!;
    expect(sheet.textContent).toMatch(/Encerrar o app pra todos|End the app for everyone/);
    expect(sheet.querySelectorAll("li").length).toBe(2);
  });
});

describe("endedLineText", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    `${key}${vars ? JSON.stringify(vars) : ""}`;
  const text = (model: EndedStripModel) =>
    endedLineText(model, t as unknown as Parameters<typeof endedLineText>[1]);

  it("joins the cause and the summary", () => {
    expect(text(ended())).toBe(
      'apps.strip.endedByHost{"name":"bia"} apps.strip.endedSummary{"count":4,"duration":"23 min"}',
    );
  });

  it("an operator switch is the whole line", () => {
    expect(text(ended({ disabled: true }))).toBe("apps.strip.endedDisabled");
  });

  it("no summary, no second sentence", () => {
    expect(text(ended({ summary: null, cause: { kind: "empty" } }))).toBe("apps.strip.endedEmpty");
  });
});
