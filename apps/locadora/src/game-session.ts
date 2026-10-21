/**
 * One game on the stage, from "the console is booting" to "ejected": the glue
 * between the emulator facade, the saves, the HUD, the drawer and the load
 * overlay. It owns no look of its own and no rule that another module has; it
 * puts them in the order SPEC 4.3 to 4.7 give.
 *
 * The order that matters:
 *  1. the console boots behind the load overlay (`runtime.start`, which
 *     resolves on EmulatorJS's `ready` with our Start still unpressed);
 *  2. the stored battery save is written into it (`saves.restoreSram`),
 *     BEFORE the game starts, so the cartridge finds its own save;
 *  3. our Start button (or the "continue" prompt) is the user gesture: its
 *     click calls `runtime.begin()` synchronously and awaits nothing first;
 *  4. on the emulator's `start` event the HUD, the shortcuts, the drawer and
 *     the saves' clocks come up and the overlay opens like a screen.
 *
 * The HUD is only created at step 4: its shortcuts talk to a running console,
 * and before the first press there is none.
 */
import type { PqpApp } from "@pqp/app-sdk";
import { createEmulatorRuntime, type EjsRuntime, type EmulatorLanguage } from "./emulator";
import { createHud, type Hud, type HudAction } from "./hud";
import type { Strings } from "./i18n";
import type { Platform as ConsoleGroup } from "./keymap";
import {
  CONSOLE_NAMES,
  consoleGroup,
  displayTitle,
  formatAgo,
  isJustNow,
  markPlayed,
  removeItem,
  renameItem,
  sanitiseUserTitle,
  type LibraryItem,
} from "./library";
import { createLoadFlow, type LoadFlow, type StartChoice } from "./load-flow";
import type { PrefsKeeper } from "./prefs";
import type { ScreenMachine } from "./screen";
import { createSaves, type ManualSlot, type Saves, type SavesEvent, type SlotInfo } from "./saves";
import { systemForExtension, type Stage } from "./stage";
import type { DeviceStore } from "./store";
import type { CoreName } from "./systems";
import { createNamePrompt } from "./ui/ficha";
import { createCartridgeScene } from "./ui/cartridge";
import { createBoxArt } from "./ui/game-box";
import { fill } from "./ui/dom";
import { createSlotDrawer, slotName, type DrawerSync, type SlotDrawer } from "./ui/slot-drawer";
import { createConflictSheet } from "./ui/conflict-sheet";
import type { ContinueOffer, GameSync, PrepareResult, SyncAccount, SyncConflict, SyncProblem } from "./sync";

/** What a game needs to boot, from either way in: the picker or the shelf. */
export interface GameInput {
  item: LibraryItem;
  rom: ArrayBuffer;
  core: CoreName;
  ext: string;
  coreData: ArrayBuffer;
  report: ArrayBuffer;
  /** NES files carry no title: offer the name field while the console boots. */
  askName: boolean;
  /**
   * The cartridge went on the shelf with this very pick. If the console then cannot run it, "Voltar pra prateleira"
   * takes it off again: a file that never ran is not kept (a game that ran before, picked from the shelf, is).
   */
  isNew?: boolean;
}

export interface StartIntent {
  /** Open the saves drawer as soon as the game is up ("Escolher save"). */
  drawer?: boolean;
  /** No question: Start loads the autosave ("Continuar"). */
  continueAuto?: boolean;
  /** A line for the first toast, with a way to the shelf (the disk would not keep the cartridge). */
  notice?: string;
}

export type LeaveReason = "eject" | "back" | "ended";

export interface SessionContext {
  app: Pick<PqpApp, "hello">;
  t: Strings;
  locale: string;
  language: EmulatorLanguage;
  accent: string | undefined;
  store: DeviceStore;
  prefs: PrefsKeeper;
  stage: Stage;
  screens: ScreenMachine;
  elements: { play: HTMLElement; stage: HTMLElement; game: HTMLElement };
  isFullscreen(): boolean;
  toggleFullscreen(): Promise<void>;
  /** The controller map over the game; `onClosed` runs when it is put away. */
  openControls(platform: ConsoleGroup, onClosed: () => void): void;
  /** "Levar pra outro aparelho", from the saves drawer's footer. Left out, the drawer draws no link. */
  openExport?(): void;
  /** The game is over for now: the shelf takes over. */
  onLeave(reason: LeaveReason, item: LibraryItem): void;
  /**
   * Saves na conta (`locadora_save_sync`): the account this session's saves are copied to, or null where it is
   * off. Null keeps everything exactly as it was: the saves stay on this device and nothing else is asked.
   */
  sync?: SyncAccount | null;
  /**
   * Why Saves na conta is not working when the server has it on (the account did not answer, this browser keeps
   * nothing). The drawer says so instead of drawing nothing. Null where the feature is off, or working.
   */
  syncProblem?: SyncProblem | null;
  now?: () => number;
  /** The console behind the session; tests stand a fake in. */
  createRuntime?: () => EjsRuntime;
}

export interface GameSession {
  readonly playing: boolean;
  start(input: GameInput, intent?: StartIntent): Promise<void>;
  eject(): Promise<void>;
  /** The host ended the session: write what can still be written, then stop. */
  end(): Promise<void>;
  /** The room became (or stopped being) full screen. */
  setFullscreen(full: boolean): void;
  /** The stage laid itself out again: the HUD's screen pill follows. */
  syncStage(): void;
  /** A key was rebound in the controller map: the running console follows. */
  applyKeymap(platform: ConsoleGroup, map: Readonly<Record<string, string>>): void;
}

/** How often the core's frame size is asked for while the game runs (a change of the canvas's size asks sooner). */
export const SIZE_WATCH_MS = 500;
/** Ejetar waits this long, at most, for what is still going up to the account. */
export const EJECT_SYNC_WAIT_MS = 10_000;
/** Loading a state the instant the core says `start` can beat its first frame. */
const CONTINUE_DELAY_MS = 300;
/** A console that has not said `ready` by now is not going to: the person gets the error screen, never a loading screen for good. */
export const READY_TIMEOUT_MS = 45_000;
/** Once Start was pressed (the core is downloaded and started after that click), how long the game may take to come up before it is given up on. */
export const START_TIMEOUT_MS = 40_000;
/** After the game came up, how often its frame counter is read, and for how long, to tell a game from RetroArch's empty menu. */
export const FRAME_CHECK_MS = 500;
export const FRAME_CHECK_TRIES = 12;

/** A runtime error of the core itself (emscripten's abort), as opposed to any other error on the page. */
export function looksLikeCoreCrash(event: { message?: unknown; error?: unknown }): boolean {
  const error = event.error as { name?: unknown; message?: unknown } | undefined;
  const text = `${String(event.message ?? "")} ${String(error?.message ?? "")}`;
  return error?.name === "RuntimeError" || /\bAborted\(/.test(text) || /^RuntimeError\b/.test(text);
}

export function createGameSession(ctx: SessionContext): GameSession {
  const { t, store, prefs, stage, elements } = ctx;
  const now = ctx.now ?? Date.now;

  let playing = false;
  let generation = 0;
  let ending = false;
  let input: GameInput | null = null;
  let intent: StartIntent = {};
  let runtime: EjsRuntime | null = null;
  let saves: Saves | null = null;
  let hud: Hud | null = null;
  let drawer: SlotDrawer | null = null;
  let flow: LoadFlow | null = null;
  let unsubscribe: (() => void) | null = null;
  let thumbUrls: string[] = [];
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let muted = prefs.prefs.muted;
  let started = false;
  /** The core's error screen is up: it is said once, whatever fires after it. */
  let errorShown = false;
  /** Unpaused play, for the "played" total of the Ficha. */
  let playedMs = 0;
  let runningSince: number | null = null;
  let namePromptInput: HTMLInputElement | null = null;
  let nameInitial = "";
  let removeFocusWatch: (() => void) | null = null;
  let removeCrashWatch: (() => void) | null = null;
  let removeSizeWatch: (() => void) | null = null;
  /* Saves na conta: this game's copy on the account, what boot found, and the sheets waiting to be asked */
  let gameSync: GameSync | null = null;
  let syncOffer: ContinueOffer | null = null;
  let remoteApplied: Promise<void> = Promise.resolve();
  let conflictQueue: SyncConflict[] = [];
  let askingConflict = false;
  let removeSyncWatch: Array<() => void> = [];

  const group = (): ConsoleGroup => consoleGroup(input!.item.platform);

  function focusGame() {
    elements.game.focus({ preventScroll: true });
  }

  /* ---- the play clock ---- */
  function clockOn() {
    if (runningSince === null) runningSince = now();
  }
  function clockOff() {
    if (runningSince !== null) {
      playedMs += now() - runningSince;
      runningSince = null;
    }
  }

  /* ---- Saves na conta ---- */
  function drawerSync(): DrawerSync | null {
    const account = ctx.sync;
    const problem = ctx.syncProblem;
    if (!account && problem) return { state: "error", readOnly: false, used: 0, cap: 0, problem };
    if (!account || !gameSync) return null;
    return { state: gameSync.status, readOnly: account.mode === "read-only", used: account.usage.used, cap: account.usage.cap };
  }

  function pictureUrl(bytes: Uint8Array | null): string | undefined {
    if (!bytes) return undefined;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
    thumbUrls.push(url);
    return url;
  }

  /** One conflict, asked with both pictures; `place` is the load overlay (before boot) or over the game. */
  function askConflict(conflict: SyncConflict, place: "flow" | "stage"): Promise<void> {
    const sync = gameSync;
    if (!sync) return Promise.resolve();
    const mine = generation;
    return new Promise<void>((resolve) => {
      const sheet = createConflictSheet({
        t,
        slotLabel: conflict.slot === "sram" ? null : slotName(conflict.slot, t),
        local: { savedAt: conflict.local.savedAt, device: conflict.local.device, thumbUrl: pictureUrl(conflict.local.thumb) },
        remote: { savedAt: conflict.remote.savedAt, device: conflict.remote.device, thumbUrl: pictureUrl(conflict.remote.thumb) },
        both: conflict.slot === "sram" || conflict.slot === "auto" ? "none" : conflict.freeSlot !== null ? "offer" : "full",
        now,
        onChoose: (choice) => {
          void sync
            .resolve(conflict, choice)
            .catch(() => undefined)
            .then(() => {
              sheet.destroy();
              if (mine === generation) void refreshDrawer();
              resolve();
            });
        },
      });
      if (place === "flow" && flow) flow.showPanel(sheet.element);
      else elements.stage.append(sheet.element);
      sheet.focus();
    });
  }

  /** Conflicts met while playing (or found at boot for the drawer's slots): one at a time, the game paused under them. */
  async function drainConflicts() {
    if (askingConflict || !hud || !runtime) return;
    askingConflict = true;
    const mine = generation;
    const wasPaused = hud.paused;
    if (!wasPaused) hud.setPaused(true);
    hud.setActive(false);
    runtime.setKeyboard(false);
    while (conflictQueue.length > 0 && mine === generation) {
      const next = conflictQueue.shift()!;
      await askConflict(next, "stage");
    }
    askingConflict = false;
    if (mine !== generation || !hud || !runtime) return;
    runtime.setKeyboard(true);
    hud.setActive(true);
    if (!wasPaused) hud.setPaused(false);
    focusGame();
  }

  function queueConflict(conflict: SyncConflict) {
    if (conflictQueue.some((waiting) => waiting.slot === conflict.slot)) return;
    conflictQueue.push(conflict);
    if (started) void drainConflicts();
  }

  /** "Apagar tudo da conta", confirmed in the drawer. */
  async function clearAccount(): Promise<boolean> {
    const account = ctx.sync;
    if (!account) return false;
    try {
      await account.clearAll();
      hud?.toast(t["sync.cleared"]);
      void refreshDrawer();
      return true;
    } catch {
      hud?.toast(t["sync.clearFailed"]);
      return false;
    }
  }

  /** What boot asks the account, bounded, before the battery save goes in. */
  async function prepareSync(): Promise<PrepareResult | null> {
    if (!gameSync) return null;
    try {
      return await gameSync.prepare();
    } catch {
      return null;
    }
  }

  /* ---- slots and the drawer ---- */
  async function refreshDrawer(): Promise<SlotInfo[] | undefined> {
    const liveSaves = saves;
    const liveDrawer = drawer;
    if (!liveSaves || !liveDrawer) return undefined;
    const slots = await liveSaves.listSlots();
    // the game may have been ejected while the slots were being read
    if (drawer !== liveDrawer) return undefined;
    liveDrawer.update({
      slots,
      current: liveSaves.currentSlot,
      sramSavedAt: liveSaves.sramSavedAt,
      battery: liveSaves.hasBattery,
      autosave: liveSaves.autosaveEnabled,
      sync: drawerSync(),
    });
    return slots;
  }

  function setDrawer(open: boolean) {
    if (!drawer || drawer.isOpen === open) return;
    if (open) {
      void refreshDrawer().then(() => {
        drawer?.open();
        syncDrawerFlags();
      });
    } else {
      drawer.close();
      syncDrawerFlags();
    }
  }

  function syncDrawerFlags() {
    const open = drawer?.isOpen ?? false;
    elements.play.dataset.drawer = open ? "open" : "closed";
    hud?.setDrawerOpen(open);
    stage.relayout();
  }

  function onSavesEvent(event: SavesEvent) {
    if (!hud) return;
    switch (event.type) {
      case "slot-saved":
        hud.notifySaved(event.slot, () => void saves?.undo().then(() => refreshDrawer()));
        void refreshDrawer();
        break;
      case "autosaved":
      case "sram-saved":
      case "slot-deleted":
      case "undone":
        void refreshDrawer();
        break;
      case "slot-loaded":
        if (event.slot === "auto") hud.toast(t["toast.loadedAuto"]);
        else hud.notifyLoaded(event.slot);
        break;
      case "slot-selected":
        hud.setSlot(event.slot);
        void refreshDrawer();
        break;
      case "old-core":
        hud.toast(t["saves.oldCore"], { label: t["saves.tryAnyway"], run: () => void saves?.loadSlot(event.slot, { force: true }) });
        break;
      case "autosave-switched":
        prefs.update({ autosave: event.on });
        void refreshDrawer();
        break;
      case "storage-full":
        hud.toast(t["err.storage"], { label: t["err.openShelf"], run: () => void eject() });
        break;
      case "error":
        if (event.where === "load") hud.toast(t["err.badState"]);
        else if (event.where === "save" && !(event.error instanceof Error && (event.error as { code?: string }).code === "too-large")) {
          hud.toast(t["err.saveFailed"]);
        }
        break;
      default:
    }
  }

  async function loadSlot(slot: Parameters<Saves["loadSlot"]>[0], force = false) {
    const liveSaves = saves;
    if (!liveSaves || !hud) return;
    const result = await liveSaves.loadSlot(slot, { force });
    if (!result.ok && result.reason === "empty") hud?.toast(t["saves.empty"]);
  }

  async function saveSlot(slot: ManualSlot) {
    if (!saves) return;
    saves.selectSlot(slot);
    await saves.saveSlot(slot);
  }

  /* ---- the HUD's asks ---- */
  function onAction(action: HudAction, slot: number) {
    switch (action) {
      case "save":
        void saveSlot(slot as ManualSlot);
        break;
      case "load":
        void loadSlot(slot as ManualSlot);
        break;
      case "saves":
        setDrawer(!(drawer?.isOpen ?? false));
        break;
      case "controls":
        openControls();
        break;
      case "sound":
        muted = !muted;
        runtime?.setMuted(muted);
        hud?.setMuted(muted);
        prefs.update({ muted });
        break;
      case "fullscreen":
        void ctx.toggleFullscreen();
        break;
      case "eject":
        void eject();
        break;
    }
  }

  function openControls() {
    if (!hud || !runtime) return;
    const wasPaused = hud.paused;
    if (!wasPaused) hud.setPaused(true);
    // the map listens for keys: neither the game nor our own shortcuts may take them first
    hud.setActive(false);
    runtime.setKeyboard(false);
    ctx.openControls(group(), () => {
      if (!hud || !runtime) return;
      runtime.setKeyboard(true);
      hud.setActive(true);
      if (!wasPaused) hud.setPaused(false);
      focusGame();
    });
  }

  /* ---- starting ---- */
  function artFor(item: LibraryItem, width: number) {
    return createBoxArt(item, width);
  }

  /** What the load overlay shows: the cartridge of this game, its title on the label, going into the console. */
  function cartFor(item: LibraryItem) {
    return createCartridgeScene({ title: displayTitle(item), platform: item.platform });
  }

  function cleanup(): void {
    generation += 1;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    removeFocusWatch?.();
    removeFocusWatch = null;
    removeCrashWatch?.();
    removeCrashWatch = null;
    removeSizeWatch?.();
    removeSizeWatch = null;
    for (const stop of removeSyncWatch) stop();
    removeSyncWatch = [];
    gameSync?.dispose();
    gameSync = null;
    syncOffer = null;
    remoteApplied = Promise.resolve();
    conflictQueue = [];
    askingConflict = false;
    for (const node of elements.stage.querySelectorAll(".loc-conflict")) node.remove();
    unsubscribe?.();
    unsubscribe = null;
    flow?.destroy();
    flow = null;
    drawer?.destroy();
    drawer = null;
    hud?.destroy();
    hud = null;
    saves?.dispose();
    saves = null;
    runtime?.stop();
    runtime = null;
    for (const url of thumbUrls) URL.revokeObjectURL(url);
    thumbUrls = [];
    delete elements.play.dataset.drawer;
    namePromptInput = null;
  }

  async function start(next: GameInput, nextIntent: StartIntent = {}): Promise<void> {
    cleanup();
    const mine = generation;
    input = next;
    intent = nextIntent;
    playing = true;
    ending = false;
    started = false;
    errorShown = false;
    playedMs = 0;
    runningSince = null;
    const { item } = next;

    stage.setSystem(systemForExtension(next.ext) ?? "nes");
    ctx.screens.go("palco");
    stage.relayout();

    flow = createLoadFlow({
      host: elements.stage,
      t,
      art: cartFor(item),
      title: displayTitle(item),
      console: CONSOLE_NAMES[item.platform],
      onBack: back,
    });
    flow.setStep(2);

    if (next.askName) {
      nameInitial = displayTitle(item);
      const prompt = createNamePrompt({
        t,
        initial: nameInitial,
        skipLabel: t["name.skip"],
        onSubmit: (title) => {
          void commitName(title);
          // the field is gone: the keyboard goes on to Start, where it was headed
          flow?.element.querySelector<HTMLElement>(".loc-start")?.focus({ preventScroll: true });
        },
        onSkip: () => {
          flow?.setExtra(null);
          flow?.element.querySelector<HTMLElement>(".loc-start")?.focus({ preventScroll: true });
        },
      });
      namePromptInput = prompt.element.querySelector("input");
      flow.setExtra(prompt.element);
    }

    const created = (ctx.createRuntime ?? createEmulatorRuntime)();
    runtime = created;
    const savesNow = createSaves({ store, runtime: created, sha: item.sha256, autosave: prefs.prefs.autosave, requireShelf: true });
    saves = savesNow;
    gameSync =
      ctx.sync?.forGame({
        sha: item.sha256,
        platform: item.platform,
        console: () => {
          try {
            return created.stateInfo?.() ?? null;
          } catch {
            return null;
          }
        },
        now,
      }) ?? null;

    // a console that never says `ready` must not leave the loading screen up for good
    let ready = false;
    timers.push(setTimeout(() => {
      if (mine === generation && !ready) showCoreError();
    }, READY_TIMEOUT_MS));

    try {
      await created.start({
        container: "#game",
        core: next.core,
        ext: next.ext,
        rom: next.rom,
        coreData: next.coreData,
        report: next.report,
        language: ctx.language,
        accent: ctx.accent,
        keymap: prefs.prefs.keymaps[group()],
        onStart: () => void afterStart(mine),
        // the emulator gave up (it fails after Start, when the file turns out not to be a game): never a dead screen
        onError: () => {
          if (mine === generation) showCoreError();
        },
      });
    } catch {
      if (mine !== generation) return;
      showCoreError();
      return;
    }
    if (mine !== generation) return;
    ready = true;

    // Saves na conta: what is clean comes down from the account first, and a battery save that changed on both sides
    // is the person's call, before the cartridge reads it
    const prepared = await prepareSync();
    if (mine !== generation) return;
    if (prepared?.sramConflict) {
      flow?.setStep(3);
      await askConflict(prepared.sramConflict, "flow");
      if (mine !== generation) return;
    }
    conflictQueue = [...(prepared?.conflicts ?? [])];
    syncOffer = prepared?.continueOffer ?? null;

    // the battery save goes in BEFORE the game starts, so the cartridge finds it
    await savesNow.restoreSram();
    if (mine !== generation) return;

    flow?.setStep(3);
    const auto = await autosaveFor(savesNow);
    if (mine !== generation) return;
    // the account holds a newer autosave from another device: that question comes first, even after "Continuar" on
    // the shelf (which meant "where I stopped", and where they stopped is the other device)
    if (syncOffer) {
      const offer = syncOffer;
      const line = fill(t["sync.continue"], {
        device: t[`sync.device.${offer.remote.device}`],
        ago: formatAgo(offer.remote.savedAt, now()),
      });
      flow?.showStart(
        {
          remote: {
            line,
            thumbUrl: pictureUrl(offer.remote.thumb),
            localThumbUrl: pictureUrl(offer.local?.thumb ?? null),
            hasLocal: offer.local !== null,
          },
        },
        (choice) => press(choice),
      );
      return;
    }
    flow?.showStart(intent.continueAuto ? {} : { autosave: auto }, (choice) => press(choice));
  }

  /** The autosave's picture and age, when there is one this console can read. */
  async function autosaveFor(forSaves: Saves): Promise<{ thumbUrl?: string; ago: string; justNow: boolean } | undefined> {
    try {
      const slots = await forSaves.listSlots();
      const auto = slots.find((slot) => slot.slot === "auto" && !slot.empty);
      if (!auto || auto.savedAt === null) return undefined;
      let thumbUrl: string | undefined;
      if (auto.thumb) {
        thumbUrl = URL.createObjectURL(new Blob([auto.thumb as BlobPart], { type: "image/png" }));
        thumbUrls.push(thumbUrl);
      }
      return { thumbUrl, ago: formatAgo(auto.savedAt, now()), justNow: isJustNow(auto.savedAt, now()) };
    } catch {
      return undefined;
    }
  }

  let pendingChoice: StartChoice = "fresh";

  /** The click on Start. Everything before `begin()` is synchronous: the audio needs this very gesture. */
  function press(choice: StartChoice) {
    // with the account's question on screen the answer is the person's own; otherwise "Continuar" on the shelf decides
    pendingChoice = syncOffer ? (choice === "remote" ? "continue" : choice) : intent.continueAuto ? "continue" : choice;
    const typed = namePromptInput?.value;
    const mine = generation;
    const ok = runtime?.begin() ?? false;
    // Saves na conta, after the console began (nothing may come before that call): the account's autosave is written
    // into this device's before the continue load reads it (afterStart waits on it); any other answer keeps this
    // device's, and its next autosave overwrites the account's
    if (gameSync && syncOffer) {
      remoteApplied = choice === "remote" ? gameSync.acceptContinue().catch(() => undefined) : gameSync.declineContinue().catch(() => undefined);
      syncOffer = null;
    }
    // the emulator starts the game inside that very click, so a file it cannot run has already failed by here
    if (!ok || runtime?.failed()) {
      showCoreError();
      return;
    }
    // and one that neither starts nor fails still ends in the error screen, never in a loading screen for good
    timers.push(
      setTimeout(() => {
        if (mine === generation && !started) showCoreError();
      }, START_TIMEOUT_MS),
    );
    if (typed !== undefined) void commitName(typed);
  }

  async function commitName(raw: string) {
    flow?.setExtra(null);
    namePromptInput = null;
    const title = sanitiseUserTitle(raw);
    if (!input || title === "" || title === nameInitial) return;
    const updated = await renameItem(store, input.item.sha256, title).catch(() => null);
    if (updated && input) {
      input = { ...input, item: updated };
      hud?.setInfo({ title: displayTitle(updated), console: CONSOLE_NAMES[updated.platform], art: artFor(updated, 40) });
    }
  }

  async function afterStart(mine: number) {
    if (mine !== generation || !runtime || !saves || !input || started) return;
    started = true;
    const item = input.item;
    const liveRuntime = runtime;
    const liveSaves = saves;

    hud = createHud({
      host: elements.stage,
      t,
      locale: ctx.locale,
      runtime: liveRuntime,
      stage,
      game: elements.game,
      focusGame,
      info: { title: displayTitle(item), console: CONSOLE_NAMES[item.platform], art: artFor(item, 40) },
      onAction,
      turboRatio: prefs.prefs.turboRatio,
      onTurboRatioChange: (turboRatio) => prefs.update({ turboRatio }),
      onSlotChange: (slot) => liveSaves.selectSlot(slot as ManualSlot),
      onPausedChange: (paused) => {
        liveSaves.setPaused(paused);
        if (paused) clockOff();
        else clockOn();
      },
    });
    hud.setFullscreen(ctx.isFullscreen());
    if (muted) {
      liveRuntime.setMuted(true);
      hud.setMuted(true);
    }

    drawer = createSlotDrawer({
      t,
      locale: ctx.locale,
      slots: [],
      current: liveSaves.currentSlot,
      sramSavedAt: liveSaves.sramSavedAt,
      battery: liveSaves.hasBattery,
      autosave: liveSaves.autosaveEnabled,
      onLoad: (slot, { force }) => void loadSlot(slot, force),
      onSave: (slot) => void saveSlot(slot),
      onSelect: (slot) => liveSaves.selectSlot(slot),
      onDelete: (slot) => void liveSaves.deleteSlot(slot),
      onToggleAutosave: (on) => liveSaves.setAutosave(on),
      sync: drawerSync(),
      ...(ctx.sync ? { onClearAccount: clearAccount } : {}),
      // the battery save is written first, so the file carries what the game last had, not the last 30 s tick
      ...(ctx.openExport ? { onExport: () => void liveSaves.flushSram("interval").catch(() => false).then(() => ctx.openExport?.()) } : {}),
      onClose: () => {
        syncDrawerFlags();
        focusGame();
      },
    });
    drawer.element.hidden = true;
    elements.play.append(drawer.element);

    unsubscribe = liveSaves.on(onSavesEvent);
    const liveSync = gameSync;
    if (liveSync) {
      removeSyncWatch.push(
        liveSaves.on((event) => liveSync.onSavesEvent(event)),
        liveSync.onConflict(queueConflict),
        liveSync.onChange(() => void refreshDrawer()),
      );
      if (ctx.sync) removeSyncWatch.push(ctx.sync.onChange(() => void refreshDrawer()));
    }
    liveSaves.start();
    clockOn();
    void markPlayed(store, item.sha256, now()).catch(() => undefined);

    // a click on the HUD or the drawer leaves the focus on the page: hand it back so the keys reach the core
    const watch = () =>
      queueMicrotask(() => {
        const active = elements.stage.ownerDocument.activeElement;
        if (hud && (active === null || active === elements.stage.ownerDocument.body)) focusGame();
      });
    elements.stage.addEventListener("click", watch);
    removeFocusWatch = () => elements.stage.removeEventListener("click", watch);

    // a crash of the core itself (emscripten's abort) is an uncaught error on the page
    const onError = (event: ErrorEvent) => {
      if (mine === generation && looksLikeCoreCrash(event)) void showCrash();
    };
    const win = elements.stage.ownerDocument.defaultView ?? window;
    win.addEventListener("error", onError);
    removeCrashWatch = () => win.removeEventListener("error", onError);

    // The core's frame size, for as long as the game runs. A game changes its picture while it plays (a SNES game
    // goes between 224 and 239 lines, 256 and 512 wide, and a core may report a placeholder until its first real
    // frame), so the size read once was a size kept for good: the box was fitted to a frame the core no longer drew.
    // It is asked again every SIZE_WATCH_MS, and at once when the canvas's own size changes (RetroArch resizes the
    // canvas when the geometry does), and the stage lays itself out again only when the answer is a different one.
    const readSize = () => {
      if (mine !== generation || !runtime) return;
      const size = runtime.videoSize();
      if (size) stage.setBase(size.width, size.height);
    };
    const watchSize = () => {
      readSize();
      if (mine === generation) timers.push(setTimeout(watchSize, SIZE_WATCH_MS));
    };
    watchSize();
    const canvasWatch =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => readSize());
    const watchCanvas = () => {
      const canvas = elements.game.querySelector("canvas.ejs_canvas");
      if (canvas) canvasWatch?.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    };
    watchCanvas();
    removeSizeWatch = () => canvasWatch?.disconnect();

    // a file the console cannot run may still "start": RetroArch then sits in its own menu and the frame counter
    // never moves. That is the cartridge being bad, and the person is told so instead of being shown a menu.
    let still = 0;
    const checkFrames = () => {
      if (mine !== generation || !runtime) return;
      const frames = runtime.frames();
      if (frames === null || frames > 0 || hud?.paused) {
        if (frames === 0 && hud?.paused) timers.push(setTimeout(checkFrames, FRAME_CHECK_MS));
        return;
      }
      still += 1;
      if (still >= FRAME_CHECK_TRIES) showCoreError();
      else timers.push(setTimeout(checkFrames, FRAME_CHECK_MS));
    };
    timers.push(setTimeout(checkFrames, FRAME_CHECK_MS));

    await flow?.reveal();
    if (mine !== generation) return;
    flow = null;
    focusGame();

    if (pendingChoice === "continue") {
      const applied = remoteApplied;
      timers.push(setTimeout(() => void applied.then(() => (mine === generation ? loadSlot("auto") : undefined)), CONTINUE_DELAY_MS));
    }
    // the drawer's slots that changed on both sides, found at boot: asked now the game is up
    if (conflictQueue.length > 0) void drainConflicts();
    if (intent.drawer) setDrawer(true);
    if (intent.notice) hud?.toast(intent.notice, { label: t["err.openShelf"], run: () => void eject() });
  }

  /* ---- the error table (SPEC 4.7) ---- */
  function showCoreError() {
    if (!input || errorShown) return;
    errorShown = true;
    const failed = input;
    const failedIntent = intent;
    // whatever the console is showing (RetroArch's own menu, a black frame) is not for the person: the console is
    // stopped, nothing is saved from it, and the HUD and the drawer, which would only offer buttons that cannot
    // work, go away
    hud?.destroy();
    hud = null;
    drawer?.destroy();
    drawer = null;
    delete elements.play.dataset.drawer;
    saves?.dispose();
    runtime?.stop();
    const over =
      flow ??
      createLoadFlow({
        host: elements.stage,
        t,
        art: cartFor(failed.item),
        title: displayTitle(failed.item),
        console: CONSOLE_NAMES[failed.item.platform],
      });
    flow = over;
    over.showError(t["err.core"], [
      { label: t["err.retry"], primary: true, run: () => void start(failed, failedIntent) },
      {
        label: t["err.back"],
        run: () => {
          // a cartridge that has never run is not worth a place on the shelf (and its row would be a box that cannot play)
          const discard = failed.isNew ? removeItem(store, failed.item.sha256).catch(() => []) : Promise.resolve([]);
          void discard.then(() => leave("back"));
        },
      },
    ]);
  }

  async function showCrash() {
    if (!input || !saves || ending) return;
    const crashed = input;
    const savesBefore = saves;
    clockOff();
    let auto: { ago: string; justNow: boolean } | undefined;
    try {
      const slots = await savesBefore.listSlots();
      const found = slots.find((slot) => slot.slot === "auto" && !slot.empty && slot.savedAt !== null);
      if (found && found.savedAt !== null) auto = { ago: formatAgo(found.savedAt, now()), justNow: isJustNow(found.savedAt, now()) };
    } catch {
      auto = undefined;
    }
    // the console is gone: what is on screen is the overlay, the HUD would only offer buttons that cannot work
    hud?.setActive(false);
    const over = createLoadFlow({
      host: elements.stage,
      t,
      art: cartFor(crashed.item),
      title: displayTitle(crashed.item),
      console: CONSOLE_NAMES[crashed.item.platform],
    });
    flow = over;
    const actions = [
      ...(auto
        ? [{ label: t["err.crashLoad"], primary: true, run: () => void start(crashed, { continueAuto: true }) }]
        : [{ label: t["err.retry"], primary: true, run: () => void start(crashed) }]),
      { label: t["err.back"], run: () => void leave("back") },
    ];
    over.showError(auto ? (auto.justNow ? t["err.crashNow"] : fill(t["err.crash"], { ago: auto.ago })) : t["err.crashNoSave"], actions);
  }

  /* ---- leaving ---- */
  async function leave(reason: LeaveReason) {
    const item = input?.item;
    clockOff();
    const seconds = Math.round(playedMs / 1000);
    cleanup();
    playing = false;
    // the game file and the core are not held past the game: what is kept is on the shelf
    input = null;
    if (item) {
      if (started && seconds > 0) await markPlayed(store, item.sha256, now(), seconds).catch(() => undefined);
      ctx.onLeave(reason, item);
    }
  }

  /**
   * "Voltar" on the load overlay (and Escape there), before Start: back to the shelf without playing. The console
   * that booted is stopped (`cleanup`: its main loop, its audio, its element), the file is let go, and nothing is
   * written or answered: the autosave, the battery save and the account's copy are as they were, and the cartridge
   * stays on the shelf, its box with the focus.
   */
  function back() {
    if (!playing || started || ending) return;
    void leave("back");
  }

  async function eject() {
    if (ending || !playing) return;
    ending = true;
    const liveSaves = saves;
    if (liveSaves && started) {
      await liveSaves.eject();
      await liveSaves.settled();
      // what Ejetar just wrote goes to the account too, for at most a few seconds
      const liveSync = gameSync;
      if (liveSync) {
        await Promise.race([liveSync.flush().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, EJECT_SYNC_WAIT_MS))]);
      }
    }
    // the session may have ended meanwhile (`end` already put everything away)
    if (!playing) return;
    await leave("eject");
  }

  async function end() {
    if (!playing) return;
    ending = true;
    // after `ended` every call to the host fails, so this writes what it still can and no more
    const liveSaves = saves;
    if (liveSaves && started) {
      await liveSaves.end().catch(() => undefined);
    }
    clockOff();
    cleanup();
    playing = false;
  }

  return {
    get playing() {
      return playing;
    },
    start,
    eject,
    end,
    setFullscreen(full) {
      hud?.setFullscreen(full);
    },
    syncStage() {
      hud?.syncStage();
    },
    applyKeymap(platform, map) {
      if (playing && runtime && input && group() === platform) {
        try {
          runtime.setKeymap(map);
        } catch {
          // the console is not up yet: the map reaches it through the start options
        }
      }
    },
  };
}
