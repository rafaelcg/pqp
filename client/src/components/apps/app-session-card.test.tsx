// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardPerson, EndedCardModel, LiveCardModel } from "@/lib/apps/card-model";
import { AppSessionCard, type AppSessionCardProps } from "./app-session-card";

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

function liveModel(over: Partial<LiveCardModel> = {}): LiveCardModel {
  return {
    kind: "live",
    sessionId: "s1",
    app: { id: "pqp-eco", name: "Sala de jogos", icon: "gamepad", category: "game" },
    phase: "open",
    subtitle: { kind: "started", name: "bia", minutes: 4 },
    count: { kind: "of", players: 3, max: 4 },
    people: people(["bia", "leo", "duda"]),
    more: 0,
    full: false,
    canWatch: false,
    join: { status: "idle" },
    ...over,
  };
}

function endedModel(over: Partial<EndedCardModel> = {}): EndedCardModel {
  return {
    kind: "ended",
    app: { id: "pqp-eco", name: "Sala de jogos", icon: "gamepad", category: "game" },
    gone: false,
    disabled: false,
    summary: { participants: 4, durationSeconds: 1380 },
    starterName: "bia",
    startedAt: "2026-10-19T19:40:00.000Z",
    people: people(["bia", "leo"]),
    more: 0,
    ...over,
  };
}

function mount(model: LiveCardModel | EndedCardModel, props: Partial<AppSessionCardProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render(model, props);
}

function render(model: LiveCardModel | EndedCardModel, props: Partial<AppSessionCardProps> = {}) {
  act(() => root!.render(<AppSessionCard model={model} {...props} />));
}

const buttons = () => Array.from(host!.querySelectorAll("button"));
const text = () => host!.textContent ?? "";

describe("estado 1: ao vivo", () => {
  it("is a group named for the app, with the count and one accent button", () => {
    mount(liveModel());
    const card = host!.querySelector('[role="group"]')!;
    expect(card.getAttribute("aria-label")).toBe("Sala de jogos");
    expect(text()).toContain("bia started 4 min ago");
    expect(text()).toContain("3 in, room for 4");
    expect(buttons().map((b) => b.textContent)).toEqual(["Join"]);
    expect(buttons()[0]!.className).toContain("bg-accent");
  });

  it("Join asks to join as a player", () => {
    const onJoin = vi.fn();
    mount(liveModel(), { onJoin });
    act(() => buttons()[0]!.click());
    expect(onJoin).toHaveBeenCalledWith({ asSpectator: false });
  });

  it("the avatars are decoration: the count in text is the information", () => {
    mount(liveModel());
    const stack = host!.querySelector('[class*="space-x"]');
    expect(stack?.getAttribute("aria-hidden")).toBe("true");
    expect(stack?.children.length).toBe(3);
  });
});

describe("estado 2: dentro", () => {
  it("has Sair first and Voltar pro app second, and an accent border", () => {
    const onLeave = vi.fn();
    const onFocusApp = vi.fn();
    mount(
      liveModel({
        phase: "inside",
        subtitle: { kind: "inside", spectating: false },
        count: { kind: "inside-full", players: 4 },
      }),
      { onLeave, onFocusApp },
    );
    expect(buttons().map((b) => b.textContent)).toEqual(["Leave", "Back to the app"]);
    expect(host!.querySelector('[role="group"]')!.className).toContain("border-accent");
    expect(text()).toContain("You are in");
    expect(text()).toContain("4 in, full");
    act(() => buttons()[0]!.click());
    act(() => buttons()[1]!.click());
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onFocusApp).toHaveBeenCalledTimes(1);
  });
});

describe("estado 3: cheio", () => {
  it("says the room is full and offers Watch only when the model allows it", () => {
    const full = liveModel({
      phase: "full",
      full: true,
      canWatch: true,
      count: { kind: "full", players: 4, max: 4, watching: 2 },
    });
    const onJoin = vi.fn();
    mount(full, { onJoin });
    expect(text()).toContain("Full, 4 of 4. 2 watching");
    expect(buttons().map((b) => b.textContent)).toEqual(["Watch"]);
    act(() => buttons()[0]!.click());
    expect(onJoin).toHaveBeenCalledWith({ asSpectator: true });

    render(liveModel({ ...full, canWatch: false }));
    expect(buttons()).toHaveLength(0);
    expect(text()).toContain("Full, 4 of 4. 2 watching");
  });
});

describe("estados 4 e 5: entrando e falhou", () => {
  it("locks the button with aria-busy without dropping focus, and ignores a second press", () => {
    const onJoin = vi.fn();
    mount(liveModel(), { onJoin });
    const button = buttons()[0]!;
    button.focus();
    render(liveModel({ join: { status: "joining" } }), { onJoin });
    const joining = buttons()[0]!;
    expect(joining).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(joining.getAttribute("aria-busy")).toBe("true");
    expect(joining.getAttribute("aria-disabled")).toBe("true");
    expect(joining.hasAttribute("disabled")).toBe(false);
    expect(joining.textContent).toBe("Joining");
    act(() => joining.click());
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("shows the failure in the card as an alert, keeps focus on Tentar de novo", () => {
    const onJoin = vi.fn();
    mount(liveModel({ join: { status: "joining" } }), { onJoin });
    const button = buttons()[0]!;
    button.focus();
    render(liveModel({ join: { status: "failed", code: "connection" } }), { onJoin });
    const alerts = host!.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe("Could not join. Check your connection and try again.");
    expect(buttons()[0]).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toBe("Try again");
    act(() => button.click());
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it("names a refusal differently from a dead connection", () => {
    mount(liveModel({ join: { status: "failed", code: "not-allowed" } }));
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe("You cannot join this app.");
  });
});

describe("estado 6: reconectando", () => {
  it("freezes Voltar pro app and says why", () => {
    const onFocusApp = vi.fn();
    mount(
      liveModel({
        phase: "reconnecting",
        subtitle: { kind: "reconnecting" },
        count: { kind: "of", players: 2, max: 4 },
      }),
      { onFocusApp },
    );
    expect(text()).toContain("No connection, trying to get back");
    expect(text().toLowerCase()).toContain("reconnecting");
    expect(buttons().map((b) => b.textContent)).toEqual(["Back to the app"]);
    const back = buttons().find((b) => b.textContent === "Back to the app")!;
    expect(back.getAttribute("aria-disabled")).toBe("true");
    act(() => back.click());
    expect(onFocusApp).not.toHaveBeenCalled();
  });
});

describe("estado 7: o host saiu", () => {
  it("counts down who takes over and keeps Entrar", () => {
    mount(
      liveModel({
        phase: "host-left",
        subtitle: { kind: "handoff", host: "bia", to: { kind: "person", name: "leo" }, seconds: 108 },
      }),
    );
    expect(text()).toContain("bia left. leo takes over in 1:48");
    expect(buttons().map((b) => b.textContent)).toEqual(["Join"]);
  });
});

describe("estados 8 e 9: o registro quieto", () => {
  it("is dashed with no button, and says how it went", () => {
    mount(endedModel());
    const card = host!.querySelector('[role="group"]')!;
    expect(card.className).toContain("border-dashed");
    expect(buttons()).toHaveLength(0);
    expect(text()).toContain("It ended. 4 played for 23 min.");
    expect(text()).toContain("Started by bia, at");
  });

  it("says Desligado with its badge when the operator switched the app off", () => {
    mount(endedModel({ disabled: true, summary: null, people: [] }));
    expect(text()).toContain("pqp turned this app off. The session ended.");
    expect(text()).toContain("Off");
    expect(buttons()).toHaveLength(0);
  });

  it("is the generic card, titled App, for a session nobody saw", () => {
    mount(endedModel({ gone: true, summary: null, people: [], app: { id: "", name: "", icon: "sparkles", category: "tool" } }));
    expect(host!.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("App");
    expect(text()).toContain("It ended.");
  });

  it("an app that is not a game says took part", () => {
    mount(endedModel({ app: { id: "x", name: "Enquete", icon: "poll", category: "tool" } }));
    expect(text()).toContain("4 took part for 23 min");
  });
});

describe("motion", () => {
  it("animates in only when the message is fresh", () => {
    mount(liveModel(), { fresh: true });
    expect(host!.querySelector('[role="group"]')!.className).toContain("app-card-in");
    render(liveModel(), { fresh: false });
    expect(host!.querySelector('[role="group"]')!.className).not.toContain("app-card-in");
  });

  it("scales in only the avatar of whoever just arrived", () => {
    mount(liveModel());
    expect(host!.querySelector(".app-avatar-in")).toBeNull();
    render(liveModel({ people: people(["bia", "leo", "duda", "nina"]) }));
    expect(host!.querySelectorAll(".app-avatar-in")).toHaveLength(1);
  });
});

describe("the screen reader's voice", () => {
  const live = () => host!.querySelector('[data-testid="app-card-live"]')!;

  it("announces one join by name, and groups three within two seconds", () => {
    mount(liveModel({ people: people(["bia"]) }));
    expect(live().textContent).toBe("");
    render(liveModel({ people: people(["bia", "leo"]) }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(live().textContent).toBe("leo joined Sala de jogos");

    render(liveModel({ people: people(["bia", "leo", "duda"]) }));
    render(liveModel({ people: people(["bia", "leo", "duda", "nina"]) }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(live().textContent).toBe("2 people joined Sala de jogos");
  });

  it("says nothing when somebody leaves, and says the end once without moving focus", () => {
    mount(liveModel({ people: people(["bia", "leo"]) }));
    const button = buttons()[0]!;
    button.focus();
    render(liveModel({ people: people(["bia"]) }));
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(live().textContent).toBe("");
    render(endedModel());
    expect(live().textContent).toBe("Sala de jogos ended");
    expect(live().getAttribute("role")).toBe("status");
  });
});
