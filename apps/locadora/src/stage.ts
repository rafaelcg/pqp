/**
 * The stage (SPEC 5 of the locadora-ux-pass): how big the picture is, and the
 * little that lives around it (the TV look, the ambient light, the bezel).
 *
 * `fitStage` is a pure function so the table of sizes can be tested without a
 * browser. `createStage` is the DOM half: it wraps `#game` in a screen element
 * of the exact size `fitStage` answers, and keeps it right when the room
 * changes (a ResizeObserver, `fullscreenchange`, a new pixel ratio).
 *
 * The rule that matters is "pixel perfect": the largest whole number of DEVICE
 * pixels per source pixel that fits, so every source pixel is the same size on
 * the glass. The arithmetic is in device pixels and the answer is divided by
 * the pixel ratio, which is how a 2x screen gets 2.5 CSS pixels per source
 * pixel and still no blurred edge. Below two device pixels per source pixel
 * the whole number is not worth having and the picture is fitted instead.
 */

export type StageSystem = "nes" | "gb" | "gbc" | "gba" | "snes";
export type ScaleMode = "pixel" | "fit";
/** `square` is a pixel of 1:1; `tv` is the 8:7 pixel of the NES and SNES (handhelds have no TV option). */
export type AspectMode = "square" | "tv";

/** What the core draws, per system, until it reports its own size (`getVideoDimensions` after `start`). */
export const FALLBACK_BASE: Readonly<Record<StageSystem, readonly [number, number]>> = {
  nes: [256, 240],
  gb: [160, 144],
  gbc: [160, 144],
  gba: [240, 160],
  snes: [256, 224],
};

const SYSTEM_BY_EXTENSION: Readonly<Record<string, StageSystem>> = {
  ".nes": "nes",
  ".gb": "gb",
  ".gbc": "gbc",
  ".gba": "gba",
  ".sfc": "snes",
  ".smc": "snes",
};

export function systemForExtension(ext: string): StageSystem | null {
  return Object.hasOwn(SYSTEM_BY_EXTENSION, ext) ? (SYSTEM_BY_EXTENSION[ext] ?? null) : null;
}

/** The 8:7 pixel of the TV consoles; everything else is square. */
export const TV_PIXEL_ASPECT = 8 / 7;

export function pixelAspectFor(system: StageSystem, aspect: AspectMode): number {
  return aspect === "tv" && (system === "nes" || system === "snes") ? TV_PIXEL_ASPECT : 1;
}

/** Whether the system has a "Como na TV" option at all. */
export function hasTvAspect(system: StageSystem): boolean {
  return system === "nes" || system === "snes";
}

export interface FitInput {
  /** The room, in CSS pixels. */
  viewW: number;
  viewH: number;
  /** The frame the core draws, in source pixels. */
  baseW: number;
  baseH: number;
  /** Pixel aspect ratio (width of a source pixel over its height): 1, or 8/7. */
  par: number;
  mode: ScaleMode;
  /** `devicePixelRatio`. */
  dpr: number;
}

export interface FitResult {
  /** The picture's exact size, in CSS pixels. */
  width: number;
  height: number;
  /** The mode that was applied: `fit` when `pixel` was asked and did not fit twice over. */
  applied: ScaleMode;
  /** Device pixels per source row (a whole number when `applied` is `pixel`). */
  scale: number;
  /** The same, in CSS pixels: what a person reads as "3x". */
  cssScale: number;
  /** The whole number `pixel` would use here whatever the mode, null under 2 (it would fall back). */
  integerScale: number | null;
}

const EPSILON = 1e-9;
const MIN_INTEGER_SCALE = 2;

const EMPTY: FitResult = { width: 0, height: 0, applied: "fit", scale: 0, cssScale: 0, integerScale: null };

export function fitStage(input: FitInput): FitResult {
  const { viewW, viewH, baseW, baseH, par, mode } = input;
  const dpr = input.dpr > 0 && Number.isFinite(input.dpr) ? input.dpr : 1;
  if (!(viewW > 0 && viewH > 0 && baseW > 0 && baseH > 0 && par > 0)) return EMPTY;

  const deviceW = viewW * dpr;
  const deviceH = viewH * dpr;
  const wideW = baseW * par; // the picture's width at one device pixel per source row
  const best = Math.min(deviceW / wideW, deviceH / baseH);
  const k = Math.floor(best + EPSILON);
  const integerScale = k >= MIN_INTEGER_SCALE ? k : null;

  if (mode === "pixel" && integerScale !== null) {
    const width = Math.min(Math.round(wideW * integerScale), Math.floor(deviceW + EPSILON));
    return {
      width: width / dpr,
      height: (baseH * integerScale) / dpr,
      applied: "pixel",
      scale: integerScale,
      cssScale: integerScale / dpr,
      integerScale,
    };
  }
  // whole device pixels, rounded down: a picture a hair over the room is a picture with an edge cut off
  return {
    width: Math.min(Math.floor(wideW * best + EPSILON), Math.floor(deviceW + EPSILON)) / dpr,
    height: Math.min(Math.floor(baseH * best + EPSILON), Math.floor(deviceH + EPSILON)) / dpr,
    applied: "fit",
    scale: best,
    cssScale: best / dpr,
    integerScale,
  };
}

export interface RoomInput {
  /** The stage's own box (`clientWidth` / `clientHeight`: inside its border). */
  stageW: number;
  stageH: number;
  /** The window's (`innerWidth` / `innerHeight`): what can be on screen at all. */
  windowW: number;
  windowH: number;
  /** Kept clear on every side (the bezel). */
  margin: number;
}

/**
 * The room the picture may take: the stage's box, never more than the window. The stage is the whole of the
 * window in full screen, and in a layout that has not settled yet (the frame half way into full screen, a grid
 * that has not caught up) its box can be the old one or a larger one; the window is what is really there.
 */
export function measureRoom(input: RoomInput): { viewW: number; viewH: number } {
  // a stage with no box (hidden) has no room; a window that reports nothing only means no second opinion
  const box = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
  const bound = (value: number) => (Number.isFinite(value) && value > 0 ? value : Infinity);
  const viewW = Math.min(box(input.stageW), bound(input.windowW)) - input.margin * 2;
  const viewH = Math.min(box(input.stageH), bound(input.windowH)) - input.margin * 2;
  return { viewW: Math.max(0, viewW), viewH: Math.max(0, viewH) };
}

/** "3", "2.5": a scale as the menu says it, without trailing zeros. */
export function formatScale(cssScale: number): string {
  return String(Math.round(cssScale * 100) / 100);
}

/** A factor with at most `digits` decimals and the language's own decimal mark ("3,8" in pt-BR). */
export function formatFactor(value: number, locale: string | undefined, digits: number): string {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  if (!locale) return String(rounded);
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: digits, useGrouping: false }).format(rounded);
  } catch {
    return String(rounded);
  }
}

export interface StageSettings {
  /** null follows the room: Encaixar in a window, Pixel perfeito in full screen (SPEC 5). */
  scale: ScaleMode | null;
  aspect: AspectMode;
  crt: boolean;
  ambient: boolean;
  bezel: boolean;
}

export const DEFAULT_SETTINGS: Readonly<StageSettings> = {
  scale: null,
  aspect: "square",
  crt: false,
  ambient: false,
  bezel: false,
};

export interface StageLayout extends FitResult {
  /** The scale mode in force after the room's default was applied. */
  scaleMode: ScaleMode;
  system: StageSystem;
  baseW: number;
  baseH: number;
}

/** The bezel's room: kept clear on every side of the picture, in CSS pixels. */
export const BEZEL_PX = 18;
/** How often the ambient canvas takes a new look at the frame. */
export const AMBIENT_INTERVAL_MS = 500;

export interface StageOptions {
  /** The element the picture is centred in (`#stage`). */
  stage: HTMLElement;
  /** The emulator's container (`#game`): moved into the screen element, never emptied. */
  game: HTMLElement;
  settings?: Partial<StageSettings>;
  onLayout?: (layout: StageLayout) => void;
}

export interface Stage {
  readonly settings: Readonly<StageSettings>;
  readonly layout: Readonly<StageLayout> | null;
  /** The system picks the fallback frame size and whether "Como na TV" means anything. */
  setSystem(system: StageSystem): void;
  /** The core's own frame size (`getVideoDimensions`), when it is known. */
  setBase(width: number, height: number): void;
  /** Full screen defaults to pixel perfect and a window to fit, until a person chooses. */
  setFullscreen(full: boolean): void;
  update(patch: Partial<StageSettings>): void;
  /** Measures the room and sizes the picture; safe to call as often as needed. */
  relayout(): void;
  onChange(listener: (settings: Readonly<StageSettings>) => void): void;
  destroy(): void;
}

export function createStage(options: StageOptions): Stage {
  const { stage, game } = options;
  const doc = stage.ownerDocument;
  const win = doc.defaultView ?? window;
  let settings: StageSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  let system: StageSystem = "nes";
  let base: readonly [number, number] = FALLBACK_BASE[system];
  let fullscreen = false;
  let current: StageLayout | null = null;
  const listeners: Array<(settings: Readonly<StageSettings>) => void> = [];

  // behind the picture: the ambient light (one small canvas, blurred by CSS)
  const ambient = doc.createElement("div");
  ambient.className = "loc-ambient";
  ambient.setAttribute("aria-hidden", "true");
  const ambientCanvas = doc.createElement("canvas");
  ambientCanvas.width = 64;
  ambientCanvas.height = 60;
  ambient.append(ambientCanvas);

  // the picture's box: the emulator's element inside, the TV look over it
  const screen = doc.createElement("div");
  screen.className = "loc-screen";
  const crt = doc.createElement("div");
  crt.className = "loc-crt";
  crt.setAttribute("aria-hidden", "true");
  game.replaceWith(screen);
  screen.append(game, crt);
  stage.prepend(ambient);
  stage.dataset.stage = "";

  function effectiveScale(): ScaleMode {
    return settings.scale ?? (fullscreen ? "pixel" : "fit");
  }

  function relayout() {
    const { viewW, viewH } = measureRoom({
      stageW: stage.clientWidth,
      stageH: stage.clientHeight,
      windowW: win.innerWidth,
      windowH: win.innerHeight,
      margin: settings.bezel ? BEZEL_PX : 0,
    });
    const dpr = win.devicePixelRatio || 1;
    const par = pixelAspectFor(system, settings.aspect);
    const fit = fitStage({ viewW, viewH, baseW: base[0], baseH: base[1], par, mode: effectiveScale(), dpr });
    if (fit.width === 0) return;
    screen.style.width = `${fit.width}px`;
    screen.style.height = `${fit.height}px`;
    placeOnDevicePixels(fit);
    // one scanline per source row: the row's height in CSS pixels
    screen.style.setProperty("--loc-row", `${fit.height / base[1]}px`);
    screen.dataset.applied = fit.applied;
    current = { ...fit, scaleMode: effectiveScale(), system, baseW: base[0], baseH: base[1] };
    options.onLayout?.(current);
  }

  /**
   * Whole device pixels all the way down. The emulator sizes its canvas to its container in CSS pixels, so on a
   * 2x screen a 3.5 CSS pixel scale made it draw 896 pixels wide and the browser stretch those to 1792: two
   * different widths of source pixel. So the container is laid out in DEVICE pixels (`dpr` times the size) and
   * scaled back down by `1 / dpr`: the canvas then has exactly one backing pixel per device pixel, and the
   * emulator's own whole-number scaling is what reaches the glass. The picture also starts on a device pixel
   * (the centring can land on a half one at 1.5x), or its first column would be a blend.
   */
  function placeOnDevicePixels(fit: FitResult) {
    const dpr = win.devicePixelRatio || 1;
    if (dpr === 1) {
      game.style.width = "100%";
      game.style.height = "100%";
      game.style.transform = "";
      game.style.transformOrigin = "";
      screen.style.translate = "";
      return;
    }
    game.style.width = `${Math.round(fit.width * dpr)}px`;
    game.style.height = `${Math.round(fit.height * dpr)}px`;
    game.style.transformOrigin = "0 0";
    game.style.transform = `scale(${1 / dpr})`;
    // where the layout put it, on the page, before any nudge
    screen.style.translate = "";
    const at = screen.getBoundingClientRect();
    const snap = (css: number) => Math.round(css * dpr) / dpr - css;
    const dx = snap(at.left);
    const dy = snap(at.top);
    if (dx !== 0 || dy !== 0) screen.style.translate = `${dx}px ${dy}px`;
  }

  function paintAmbient() {
    const source = game.querySelector("canvas");
    const ctx = ambientCanvas.getContext("2d");
    if (!source || !ctx || source.width === 0) return;
    try {
      ctx.drawImage(source, 0, 0, ambientCanvas.width, ambientCanvas.height);
    } catch {
      // a canvas that cannot be read (context lost, a frame mid-resize): the next look will do
    }
  }

  let ambientTimer: ReturnType<typeof setInterval> | undefined;
  function syncAmbient() {
    const wanted = settings.ambient;
    ambient.hidden = !wanted;
    if (wanted && ambientTimer === undefined) {
      paintAmbient();
      ambientTimer = setInterval(() => {
        if (!doc.hidden) paintAmbient();
      }, AMBIENT_INTERVAL_MS);
    } else if (!wanted && ambientTimer !== undefined) {
      clearInterval(ambientTimer);
      ambientTimer = undefined;
    }
  }

  function syncAttributes() {
    screen.dataset.crt = String(settings.crt);
    screen.dataset.bezel = String(settings.bezel);
    stage.dataset.ambient = String(settings.ambient);
    syncAmbient();
  }

  syncAttributes();

  /**
   * Measure now, and again on the next two frames: a resize or a `fullscreenchange` can arrive before the layout
   * of the new size has settled (the grid catches up a frame later), and a measurement of the old box would stay.
   */
  let settleFrame: number | undefined;
  const raf = typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : null;
  function relayoutAndSettle() {
    relayout();
    if (!raf || settleFrame !== undefined) return;
    settleFrame = raf(() => {
      relayout();
      settleFrame = raf(() => {
        settleFrame = undefined;
        relayout();
      });
    });
  }

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(relayoutAndSettle);
  observer?.observe(stage);
  doc.addEventListener("fullscreenchange", relayoutAndSettle);
  win.addEventListener("resize", relayoutAndSettle);

  return {
    get settings() {
      return settings;
    },
    get layout() {
      return current;
    },
    setSystem(next) {
      system = next;
      base = FALLBACK_BASE[next];
      if (!hasTvAspect(next) && settings.aspect === "tv") settings = { ...settings, aspect: "square" };
      relayout();
    },
    setBase(width, height) {
      if (width > 0 && height > 0) base = [width, height];
      relayout();
    },
    setFullscreen(full) {
      fullscreen = full;
      relayoutAndSettle();
    },
    update(patch) {
      settings = { ...settings, ...patch };
      if (!hasTvAspect(system) && settings.aspect === "tv") settings = { ...settings, aspect: "square" };
      syncAttributes();
      relayout();
      for (const listener of listeners) listener(settings);
    },
    relayout,
    onChange(listener) {
      listeners.push(listener);
    },
    destroy() {
      observer?.disconnect();
      doc.removeEventListener("fullscreenchange", relayoutAndSettle);
      win.removeEventListener("resize", relayoutAndSettle);
      if (settleFrame !== undefined) win.cancelAnimationFrame?.(settleFrame);
      if (ambientTimer !== undefined) clearInterval(ambientTimer);
      screen.replaceWith(game);
      ambient.remove();
    },
  };
}
