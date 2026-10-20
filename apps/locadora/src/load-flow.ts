/**
 * Putting a cartridge in (SPEC 4.3, 7): what the person sees between "I picked
 * a game" and "the game is on screen".
 *
 * The overlay lives inside the stage, over the emulator's own loading text
 * (which is never shown), on the shop's room out of focus: the cartridge
 * slides down into the console's slot (300 ms, the same picture as the first
 * visit's step 4), the console's light says the phase, one stepper says what
 * is happening ("Lendo a fita · Ligando o console · Pronto"), and when the
 * console is up our own big Start button takes the place of the emulator's
 * pill. That click is the user gesture the audio needs, so the button's
 * handler runs `onStart` synchronously and does nothing else first. When the
 * game's first frame is drawn, a 1 px line opens across the screen (300 ms)
 * and the overlay goes away. With reduced motion every one of those is a
 * 150 ms crossfade.
 *
 * Until the game starts there is a way back (`onBack`): a quiet "Voltar" in
 * the top-left corner, and Escape. It is the caller's to stop the console it
 * booted; this only asks.
 *
 * What is pure (the step names, which step is in which state, how long the
 * reveal takes) is at the top and is what the tests pin. The DOM half only
 * lays it out; every animation is a CSS class (`flow.css`), because the frame's
 * CSP has no inline style.
 */
import type { Strings } from "./i18n";
import { CORE_ASSETS, type CoreName } from "./systems";
import { fill, h } from "./ui/dom";
import { icon } from "./ui/top-bar";

/* ---- pure ---- */

export type LoadStep = 1 | 2 | 3;
export type StepState = "done" | "active" | "todo";

export const INSERT_MS = 300;
export const REVEAL_MS = 300;
export const REDUCED_MS = 150;

/** The three step names, from the one line of copy (`load.steps`, split on its middle dots). */
export function loadSteps(line: string): [string, string, string] {
  const parts = line
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  return [parts[0] ?? line, parts[1] ?? "", parts[2] ?? ""];
}

/** Each step's state while `current` is the one in progress. Step 3 is "Pronto": it is active, never done, until the overlay leaves. */
export function stepStates(current: LoadStep): [StepState, StepState, StepState] {
  return [1, 2, 3].map((step) => (step < current ? "done" : step === current ? "active" : "todo")) as [StepState, StepState, StepState];
}

/** How long the reveal takes before the overlay may be removed. */
export function revealMs(reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_MS : REVEAL_MS;
}

/** The two things the page can say about motion: the system setting and the host's mirrored `data-reduced-motion`. */
export function prefersReducedMotion(doc: Document): boolean {
  const win = doc.defaultView;
  const system = typeof win?.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return system || doc.documentElement.dataset.reducedMotion === "true";
}

/** The "salvo sozinho há 2 h" text under the continue prompt's picture is the caller's; this only decides whether the prompt exists. */
export interface StartPrompt {
  /** An autosave exists for this cartridge: ask whether to pick up from it. */
  autosave?: { thumbUrl?: string; ago: string; justNow?: boolean };
  /**
   * Saves na conta: the account's autosave is newer and was written on another device ("Tu parou no computador há
   * 20 min. Bora continuar daqui?"). `line` is that sentence, already worded; both pictures are drawn when there are.
   * Takes the place of `autosave`.
   */
  remote?: { line: string; thumbUrl?: string; localThumbUrl?: string; hasLocal: boolean };
}

/** The two files a core needs, from the bundle (the host hands them over already checked against their hash). */
export async function fetchCoreFiles(
  host: { assets: { get(name: string): Promise<ArrayBuffer> } },
  core: CoreName,
): Promise<{ coreData: ArrayBuffer; report: ArrayBuffer }> {
  const names = CORE_ASSETS[core];
  const [coreData, report] = await Promise.all([host.assets.get(names.data), host.assets.get(names.report)]);
  return { coreData, report };
}

/* ---- the DOM ---- */

export type LoadFlowStrings = Pick<
  Strings,
  | "load.steps"
  | "load.aria"
  | "load.back"
  | "load.backAria"
  | "start.press"
  | "start.btn"
  | "continue.prompt"
  | "continue.go"
  | "continue.fresh"
  | "continue.saved"
  | "continue.savedNow"
  | "sync.go"
  | "sync.keepLocal"
>;

/** `remote`: the account's autosave, from the other device (Saves na conta). */
export type StartChoice = "fresh" | "continue" | "remote";

export interface LoadErrorAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface LoadFlowOptions {
  /** The positioned stage element: the overlay covers it. */
  host: HTMLElement;
  t: LoadFlowStrings;
  /** The cover of the cartridge being put in (`createBoxArt`). */
  art: Node;
  title: string;
  /** The console's name, under the title. */
  console: string;
  /**
   * Back to the shelf without playing: the corner's "Voltar" and Escape, from the moment the overlay is up until the
   * game starts (never on the error screen, which has its own way back, nor during the reveal). Left out, no button.
   */
  onBack?: () => void;
}

export interface LoadFlow {
  readonly element: HTMLElement;
  setStep(step: LoadStep): void;
  /** A node of the caller's (the NES name field) shown under the title while the console boots. */
  setExtra(node: HTMLElement | null): void;
  /**
   * Our Start. `onStart` runs inside the click, synchronously, with which button it was: it has to call
   * the emulator's `begin()` before anything is awaited, or the browser will not let the audio run.
   */
  showStart(prompt: StartPrompt, onStart: (choice: StartChoice) => void): void;
  /** A panel of the caller's (the battery save's conflict sheet) in the place the Start goes, before it. */
  showPanel(node: HTMLElement): void;
  showError(text: string, actions: LoadErrorAction[]): void;
  /** The first frame is up: the line opens and the overlay leaves. Resolves when it is gone. */
  reveal(): Promise<void>;
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The corner's arrow: a chevron and a stem, pointing back. */
function backArrow(d: Document): SVGSVGElement {
  const svg = d.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "18"], ["height", "18"], ["aria-hidden", "true"], ["focusable", "false"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2.2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) {
    svg.setAttribute(k!, v!);
  }
  const path = d.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M19 12H5M11 6l-6 6 6 6");
  svg.append(path);
  return svg;
}

export function createLoadFlow(options: LoadFlowOptions): LoadFlow {
  const { host, t } = options;
  const ownerDoc = host.ownerDocument;
  const names = loadSteps(t["load.steps"]);

  // what assistive tech hears as the phase changes; on screen the stepper says it
  const statusLine = h("p", { class: "loc-load-status", role: "status" }, names[0]);
  const stepItems = names.map((name) =>
    h("li", { class: "loc-load-step", "data-state": "todo" }, h("span", { class: "loc-load-dot" }), h("span", { class: "loc-load-step-name" }, name)),
  );
  const steps = h("ol", { class: "loc-load-steps", "aria-hidden": "true" }, ...stepItems);
  const extra = h("div", { class: "loc-load-extra" });
  const body = h("div", { class: "loc-load-body" });
  const box = h("div", { class: "loc-load-box" }, options.art);
  const slot = h("div", { class: "loc-load-slot", "aria-hidden": "true" }, box);
  const line = h("div", { class: "loc-load-line", "aria-hidden": "true" });

  let back: HTMLButtonElement | null = null;
  if (options.onBack) {
    back = h(
      "button",
      { type: "button", class: "loc-load-back", "aria-label": t["load.backAria"] },
      backArrow(ownerDoc),
      h("span", {}, t["load.back"]),
    );
    back.addEventListener("click", () => goBack());
  }

  const element = h(
    "div",
    { class: "loc-load", "data-phase": "insert", role: "group", "aria-label": t["load.aria"] },
    h("div", { class: "loc-load-bg", "aria-hidden": "true" }),
    back,
    h(
      "div",
      { class: "loc-load-main" },
      // what is going in (the console, the title, the stepper), and what is asked (the name, Start, a question)
      h(
        "div",
        { class: "loc-load-hero" },
        slot,
        h(
          "div",
          { class: "loc-load-text" },
          h("p", { class: "loc-load-title" }, options.title),
          h("p", { class: "loc-load-sub" }, options.console),
          statusLine,
          steps,
        ),
      ),
      h("div", { class: "loc-load-act" }, extra, body),
    ),
    line,
  );
  host.append(element);

  let destroyed = false;
  let step: LoadStep = 1;

  /** Back is there until the game is on its way: not on the error screen, not once the reveal has begun. */
  function canGoBack() {
    const phase = element.getAttribute("data-phase");
    return !destroyed && options.onBack !== undefined && phase !== "error" && phase !== "reveal";
  }

  function goBack() {
    if (!canGoBack()) return;
    options.onBack?.();
  }

  // Escape is the same Back, unless something on the overlay has the key first (the name field skips, the conflict
  // sheet decides later: both stop it) or a panel of the caller's is up in the Start's place
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !element.isConnected) return;
    if (!canGoBack() || element.querySelector(".loc-conflict")) return;
    event.preventDefault();
    goBack();
  };
  if (options.onBack) ownerDoc.addEventListener("keydown", onKey);

  function paintSteps() {
    stepStates(step).forEach((state, index) => stepItems[index]!.setAttribute("data-state", state));
  }
  paintSteps();

  // the cartridge has gone into the slot after INSERT_MS; the phase only matters to the CSS
  const insertTimer = setTimeout(() => {
    if (!destroyed && element.getAttribute("data-phase") === "insert") element.setAttribute("data-phase", "boot");
  }, prefersReducedMotion(ownerDoc) ? REDUCED_MS : INSERT_MS);

  function setPhase(phase: string) {
    element.setAttribute("data-phase", phase);
  }

  function teardown() {
    destroyed = true;
    clearTimeout(insertTimer);
    ownerDoc.removeEventListener("keydown", onKey);
  }

  return {
    element,
    setStep(next) {
      step = next;
      paintSteps();
      statusLine.textContent = names[next - 1] ?? "";
    },
    setExtra(node) {
      extra.replaceChildren(...(node ? [node] : []));
    },
    showStart(prompt, onStart) {
      body.replaceChildren();
      setPhase("ready");
      if (prompt.remote) {
        const { remote } = prompt;
        const go = h("button", { type: "button", class: "loc-start", "data-choice": "remote" }, icon("play", 16), h("span", {}, t["sync.go"]));
        go.addEventListener("click", () => onStart("remote"));
        const buttons: HTMLElement[] = [go];
        if (remote.hasLocal) {
          const mine = h("button", { type: "button", class: "loc-start loc-start-quiet", "data-choice": "continue" }, t["sync.keepLocal"]);
          mine.addEventListener("click", () => onStart("continue"));
          buttons.push(mine);
        }
        const fresh = h("button", { type: "button", class: "loc-start loc-start-quiet", "data-choice": "fresh" }, t["continue.fresh"]);
        fresh.addEventListener("click", () => onStart("fresh"));
        buttons.push(fresh);
        const picture = (url: string | undefined, side: string) =>
          url
            ? h("img", { class: "loc-load-thumb", "data-side": side, src: url, alt: "", width: 160, height: 107, decoding: "async" })
            : null;
        body.append(
          h(
            "div",
            { class: "loc-load-continue loc-load-remote", "data-sync": "continue" },
            h("div", { class: "loc-load-remote-pics" }, picture(remote.thumbUrl, "remote"), picture(remote.localThumbUrl, "local")),
            h(
              "div",
              { class: "loc-load-continue-text" },
              h("p", { class: "loc-load-ask" }, remote.line),
              h("div", { class: "loc-load-actions" }, ...buttons),
            ),
          ),
        );
        go.focus({ preventScroll: true });
        statusLine.textContent = names[2];
        return;
      }
      if (prompt.autosave) {
        const { autosave } = prompt;
        const go = h("button", { type: "button", class: "loc-start", "data-choice": "continue" }, icon("play", 16), h("span", {}, t["continue.go"]));
        const fresh = h("button", { type: "button", class: "loc-start loc-start-quiet", "data-choice": "fresh" }, t["continue.fresh"]);
        go.addEventListener("click", () => onStart("continue"));
        fresh.addEventListener("click", () => onStart("fresh"));
        // the autosave's picture on a small screen of its own, the shape of the pictures the drawer shows
        const thumb = autosave.thumbUrl
          ? h("span", { class: "loc-load-shot" }, h("img", { class: "loc-load-thumb", src: autosave.thumbUrl, alt: "", width: 160, height: 107, decoding: "async" }))
          : null;
        body.append(
          h(
            "div",
            { class: "loc-load-continue" },
            thumb,
            h(
              "div",
              { class: "loc-load-continue-text" },
              h("p", { class: "loc-load-ask" }, t["continue.prompt"]),
              h("p", { class: "loc-muted" }, autosave.justNow ? t["continue.savedNow"] : fill(t["continue.saved"], { ago: autosave.ago })),
              h("div", { class: "loc-load-actions" }, go, fresh),
            ),
          ),
        );
        // the press that matters is the click on one of the two, so the focus goes to the likelier
        go.focus({ preventScroll: true });
        statusLine.textContent = names[2];
        return;
      }
      const startButton = h(
        "button",
        { type: "button", class: "loc-start loc-start-big", "data-choice": "fresh" },
        h("span", { class: "loc-start-cap", "aria-hidden": "true" }, icon("play", 18)),
        h("span", {}, t["start.btn"]),
      );
      startButton.addEventListener("click", () => onStart("fresh"));
      body.append(startButton, h("p", { class: "loc-load-press" }, t["start.press"]));
      startButton.focus({ preventScroll: true });
      // the status line says the step ("Pronto"); the sentence under the button is the one that asks for the press
      statusLine.textContent = names[2];
    },
    showPanel(node) {
      body.replaceChildren(node);
      setPhase("ready");
      statusLine.textContent = names[2];
    },
    showError(text, actions) {
      body.replaceChildren();
      extra.replaceChildren();
      setPhase("error");
      // the error has its own way back ("Voltar pra prateleira"), which also knows what to do with a cartridge that never ran
      if (back) back.hidden = true;
      statusLine.textContent = "";
      const buttons = actions.map((action) => {
        const button = h("button", { type: "button", class: action.primary ? "loc-start" : "loc-start loc-start-quiet" }, action.label);
        button.addEventListener("click", action.run);
        return button;
      });
      body.append(h("p", { class: "loc-load-error", role: "alert" }, text), h("div", { class: "loc-load-actions" }, ...buttons));
      buttons[0]?.focus({ preventScroll: true });
    },
    reveal() {
      if (destroyed) return Promise.resolve();
      const ms = revealMs(prefersReducedMotion(ownerDoc));
      setPhase("reveal");
      ownerDoc.removeEventListener("keydown", onKey);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!destroyed) {
            teardown();
            element.remove();
          }
          resolve();
        }, ms);
      });
    },
    destroy() {
      teardown();
      element.remove();
    },
  };
}
