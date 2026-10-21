// @vitest-environment jsdom
/**
 * "Ver a recepção de novo" as a permanent entry on the shelf, and `?welcome=1`: a replay is never the first time,
 * so it must not write the seen flag, must not say "only shows the first time", and must not change what a new
 * device gets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "./i18n";
import { markOnboardingSeen, mountOnboarding, resetOnboardingSession, SEEN_KEY, shouldShowOnboarding, welcomeForced } from "./onboarding";
import { memoryStore } from "./store";
import { createTopBar } from "./ui/top-bar";

const t = STRINGS["pt-BR"];

const mounted: Array<{ destroy(): void }> = [];

afterEach(() => {
  // each panel listens on the document: one left behind would answer the next test's keys
  for (const one of mounted.splice(0)) one.destroy();
});

beforeEach(() => {
  resetOnboardingSession();
  document.body.innerHTML = '<section id="root"></section>';
});

function mount(extra: Record<string, unknown> = {}) {
  const root = document.getElementById("root")!;
  const onDone = vi.fn();
  const onboarding = mountOnboarding({ root, t, onPick: () => {}, onDone, gamepad: { start() {}, stop() {} } as never, ...extra });
  mounted.push(onboarding);
  return { root, onboarding, onDone };
}

describe("welcomeForced", () => {
  it("is true only for welcome=1", () => {
    expect(welcomeForced("?welcome=1")).toBe(true);
    expect(welcomeForced("?a=b&welcome=1")).toBe(true);
    expect(welcomeForced("")).toBe(false);
    expect(welcomeForced("?welcome=0")).toBe(false);
    expect(welcomeForced("?welcome=true")).toBe(false);
    expect(welcomeForced("?welcomes=1")).toBe(false);
  });
});

describe("a replay of the walkthrough", () => {
  it("starts at screen 1 of 2 and draws no 'only the first time' line", () => {
    const { root, onboarding } = mount({ replay: true });
    expect(onboarding.walkthrough.step).toBe(1);
    expect(onboarding.walkthrough.steps).toHaveLength(2);
    expect(root.querySelector(".loc-onb-once")).toBeNull();
    // the rail of two screens is still there
    expect(root.querySelectorAll(".loc-onb-steps li")).toHaveLength(2);
  });

  it("the first run still draws that line", () => {
    const { root } = mount();
    expect(root.querySelector(".loc-onb-once")?.textContent).toBe(t["onb.once"]);
  });

  it.each(["skip", "escape"])("does not write the seen flag when it ends by %s", async (how) => {
    const store = memoryStore();
    const { root, onDone } = mount({ replay: true, store });
    if (how === "skip") {
      [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t["onb.skip"])!.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true }));
    }
    expect(onDone).toHaveBeenCalledWith("skip");
    await Promise.resolve();
    expect(await store.get(SEEN_KEY)).toBeNull();
    // a device that had not seen the welcome is still a new device
    expect(await shouldShowOnboarding(store)).toBe(true);
  });

  it("does not un-see a device that had seen it", async () => {
    const store = memoryStore();
    await markOnboardingSeen(store, () => 7);
    resetOnboardingSession();
    const { root } = mount({ replay: true, store });
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t["onb.skip"])!.click();
    await Promise.resolve();
    expect((await store.get(SEEN_KEY))?.meta).toEqual({ at: 7 });
    expect(await shouldShowOnboarding(store)).toBe(false);
  });

  it("the first run, finished, still writes the flag (nothing changed for new people)", async () => {
    const store = memoryStore();
    const { root } = mount({ store });
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t["onb.skip"])!.click();
    await Promise.resolve();
    expect(await store.get(SEEN_KEY)).not.toBeNull();
  });
});

describe("the two screens of the welcome", () => {
  const next = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t["onb.next"])!;

  it("the first is the street; the second is the map and the console together, with no house rules receipt", () => {
    const { root, onboarding } = mount();
    expect(root.dataset.step).toBe("1");
    expect(root.querySelector(".loc-onb-eyebrow")?.textContent).toBe("Passo 1 de 2");
    expect(root.querySelector(".loc-onb-hero")).not.toBeNull();
    expect(root.querySelector(".loc-onb-setup")).toBeNull();
    next(root).click();
    expect(onboarding.walkthrough.step).toBe(2);
    expect(root.dataset.step).toBe("2");
    expect(root.querySelector(".loc-onb-eyebrow")?.textContent).toBe("Passo 2 de 2");
    expect(root.querySelector("#onb-title")?.textContent).toBe(t["onb.2.title"]);
    const setup = root.querySelector(".loc-onb-setup")!;
    expect(setup.querySelector(".loc-padmap, .loc-onb-controls")).not.toBeNull();
    expect(setup.querySelector(".loc-onb-pick .loc-ins")).not.toBeNull();
    expect(root.querySelector(".loc-onb-receipt, .loc-onb-rules")).toBeNull();
    expect(root.textContent).not.toContain(t["rules.title"]);
    // the last screen has no "next": the big button is the way on
    expect(next(root).hidden).toBe(true);
    expect(root.querySelectorAll(".loc-onb-steps li")).toHaveLength(2);
  });

  it("the console's button is reachable by keyboard after the map's controls, and picks", () => {
    const onPick = vi.fn();
    const { root, onDone } = mount({ onPick });
    next(root).click();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => !b.closest("[hidden]") && !b.hidden);
    const pickButton = root.querySelector<HTMLButtonElement>(".loc-onb-pick-go")!;
    const tabs = buttons.indexOf(root.querySelector<HTMLButtonElement>(".loc-onb-tab")!);
    expect(tabs).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf(pickButton)).toBeGreaterThan(tabs);
    expect(pickButton.tabIndex).toBe(0);
    pickButton.click();
    expect(onDone).toHaveBeenCalledWith("pick");
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("the map alone (Controles) is still the map and nothing else", () => {
    const { root } = mount({ steps: [3] });
    expect(root.dataset.step).toBe("3");
    expect(root.querySelector(".loc-onb-pick")).toBeNull();
    expect(root.querySelector("#onb-title")?.textContent).toBe(t["onb.3.title"]);
  });

  it("says its words in all three languages, with no em dash", () => {
    for (const locale of Object.values(STRINGS)) {
      for (const key of ["onb.2.title", "onb.2.sub", "onb.4.title", "onb.4.body"] as const) {
        expect(locale[key].length).toBeGreaterThan(3);
        expect(locale[key]).not.toContain(String.fromCharCode(0x2014));
      }
    }
  });
});

describe("the top bar's 'Ver a recepção de novo'", () => {
  function bar(onWelcome?: () => void) {
    const top = createTopBar({ t, onPick: vi.fn(), ...(onWelcome ? { onWelcome } : {}) });
    document.body.append(top.element);
    return top;
  }
  const find = (top: ReturnType<typeof bar>) =>
    [...top.element.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === t["onb.replay"]);

  it("is a real button with a quiet '?' icon, named for assistive tech and in its tooltip, and runs the handler", () => {
    const onWelcome = vi.fn();
    const button = find(bar(onWelcome))!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.classList.contains("loc-top-welcome")).toBe(true);
    // the first of the icons, the one a person finds first among them
    expect(button.parentElement!.classList.contains("loc-top-tools")).toBe(true);
    expect(button.parentElement!.firstElementChild).toBe(button);
    expect(button.dataset.tip).toBe(t["onb.replay"]);
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    button.click();
    expect(onWelcome).toHaveBeenCalledOnce();
  });

  it("is not drawn without a handler", () => {
    expect(find(bar())).toBeUndefined();
  });

  it("takes the keyboard back after the walkthrough closes, or falls back to the primary button", () => {
    const top = bar(() => {});
    top.focusWelcome();
    expect(document.activeElement).toBe(find(top));
    document.body.innerHTML = "";
    const alone = bar();
    alone.focusWelcome();
    expect(document.activeElement).toBe(alone.pickButton);
  });

  it("has a 44 px target (the icon buttons are 44 by 44) and a named label in all three languages", async () => {
    const { readFileSync } = await import("node:fs");
    const { existsSync } = await import("node:fs");
    const sheet = (name: string) => {
      const local = `src/styles/${name}`;
      return readFileSync(existsSync(local) ? local : `apps/locadora/${local}`, "utf8");
    };
    expect(sheet("shelf.css")).toMatch(/\.loc-iconbtn \{[^}]*width: 44px;[^}]*height: 44px/);
    for (const locale of Object.values(STRINGS)) {
      expect(locale["onb.replay"].length).toBeGreaterThan(5);
      expect(locale["onb.once"]).toContain(locale["onb.replay"]);
      expect(locale["onb.once"]).not.toContain("—");
    }
  });
});
