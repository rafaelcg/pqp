import "./shim";
import "@emulatorjs/emulatorjs/data/emulator.css";
import "./styles/base.css";
import "./styles/stage.css";
import "./styles/hud.css";
import "./styles/shelf.css";
import "./styles/onboarding.css";
import "./styles/slots.css";
import "./styles/flow.css";
import { applyTheme, connectWithSync, type ActivityApi, type PqpApp, type SyncApi } from "@pqp/app-sdk";
import { createActivityReporter } from "./activity";
import { createGameSession, type GameInput, type GameSession, type StartIntent } from "./game-session";
import { EMULATOR_LANGUAGE, pickLocale, STRINGS, type Strings } from "./i18n";
import type { Platform } from "./keymap";
import {
  addToLibrary,
  attachFile,
  loadLibrary,
  nextUntitledTitle,
  pickContinue,
  removeItem,
  renameItem,
  romKey,
  thumbKey,
  type LibraryItem,
  type ShelfFilter,
  type ShelfSort,
} from "./library";
import { createFullscreenTracker, type ViewportProbe } from "./fullscreen-state";
import { fetchCoreFiles } from "./load-flow";
import { loadPrefs, createPrefsKeeper } from "./prefs";
import { createScreens, type Screen } from "./screen";
import { probeShare, setShared, spectatorNames } from "./share";
import { createStage } from "./stage";
import { hostFromApp, openDeviceStore } from "./store-bridge";
import { gamesOnAccount, openSync, type SyncAccount, type SyncProblem } from "./sync";
import { coreForExtension } from "./systems";
import { chooseTape, loadNotices, pickTape, type TapeProblem } from "./tape";
import { mountOnboarding, shouldShowOnboarding, welcomeForced, type Onboarding, type Step } from "./onboarding";
import { createContinueCard } from "./ui/continue-card";
import { createExportDialog } from "./ui/export-dialog";
import { el, h, setText } from "./ui/dom";
import { createHouseRules } from "./ui/house-rules";
import { consumePowerOn } from "./ui/neon-sign";
import { createShelf, type Shelf } from "./ui/shelf";
import { createToaster } from "./ui/toast";
import { createTopBar, icon, isPickShortcut, type CloudChip, type TopBar } from "./ui/top-bar";

const root = el<HTMLElement>("loc");
const statusLine = el<HTMLElement>("status");
const shelfSection = el<HTMLElement>("v-shelf");
const onboardingSection = el<HTMLElement>("v-onboarding");
const loadingSection = el<HTMLElement>("v-loading");
const play = el<HTMLElement>("v-play");
const stageEl = el<HTMLElement>("stage");
const gameEl = el<HTMLElement>("game");
const bar = el<HTMLElement>("bar");
const watchView = el<HTMLElement>("v-watch");
const shareButton = el<HTMLButtonElement>("share");
const sharingLine = el<HTMLElement>("sharing");
const noticesPanel = el<HTMLElement>("notices");
const noticesClose = el<HTMLButtonElement>("notices-close");
const noticesText = el<HTMLElement>("notices-text");
const endedLine = el<HTMLElement>("ended");

/** Which section each screen shows; `connecting`, `outside` and `ended` show only the lines around them. */
const SECTIONS: Partial<Record<Screen, HTMLElement>> = {
  balcao: shelfSection,
  onboarding: onboardingSection,
  loading: loadingSection,
  palco: play,
  watching: watchView,
};

const screens = createScreens();
const show = (screen: Screen) => screens.go(screen);

function render(screen: Screen) {
  root.dataset.view = screen;
  for (const [name, section] of Object.entries(SECTIONS)) section.hidden = name !== screen;
  const dead = screen === "outside" || screen === "ended";
  endedLine.hidden = !dead;
  if (dead) closeNotices();
  if (screen !== "palco") {
    // the share control and its line belong to the game on screen (`syncShare` brings them back)
    shareButton.hidden = true;
    sharingLine.hidden = true;
    bar.hidden = true;
  }
}
screens.onChange(render);

/** The host fullscreens the iframe, so the page never hears `fullscreenchange`: its own size and the host's answer tell (src/fullscreen-state.ts). */
function viewportProbe(): ViewportProbe {
  return { viewW: window.innerWidth, viewH: window.innerHeight, screenW: window.screen.width, screenH: window.screen.height };
}

let closeNotices = () => {};

async function main() {
  let t: Strings = STRINGS[pickLocale(navigator.language || "en")];
  let lang = pickLocale(navigator.language || "en");
  document.documentElement.lang = lang;
  statusLine.textContent = t.connecting;
  render(screens.current);

  let app: PqpApp;
  let syncApi: SyncApi;
  let activityApi: ActivityApi;
  try {
    // `connect()` plus the port's `sync.*` and `ui.activity` calls, on their own SDK module so other apps build unchanged
    ({ app, sync: syncApi, activity: activityApi } = await connectWithSync());
  } catch {
    statusLine.textContent = "";
    endedLine.textContent = t.outside;
    endedLine.hidden = false;
    show("outside");
    return;
  }

  // the host's locale wins over the browser's: it is the one the person picked in pqp
  lang = pickLocale(app.hello.locale);
  t = STRINGS[lang];
  document.documentElement.lang = lang;
  if (app.hello.reducedMotion) document.documentElement.dataset.reducedMotion = "true";
  // the host says light or dark in one token; the stylesheet's text-safe inks (`:root[data-scheme="light"]`) follow it
  const paintTheme = (theme: Parameters<typeof applyTheme>[0]) => {
    applyTheme(theme);
    document.documentElement.dataset.scheme = theme["--pqp-color-scheme"] === "light" ? "light" : "dark";
  };
  paintTheme(app.hello.theme);
  app.on("theme", (theme) => paintTheme(theme));

  // ---- the device store: the host's, or memory when the host will not keep anything (src/store-bridge.ts) ----
  const { store, durable } = await openDeviceStore(hostFromApp(app.store));
  const keeper = createPrefsKeeper(store, await loadPrefs(store));

  // ---- Saves na conta (`locadora_save_sync`): only where the host and the server say so, never for a watcher ----
  // A refusal is the quiet "off". Anything else (the account did not answer, this browser keeps nothing) is a
  // `syncProblem`: logged by `openSync`, drawn on the shelf and in the drawer, never a feature that is just missing.
  const isSpectator = app.hello.self.role === "spectator";
  // The signed-out guest player (pqp.gg/locadora/jogar): no account behind it, so nothing here asks for one. The
  // account saves are never opened (the host refuses them anyway), there is no share to probe, and one more line on
  // the receipt says the shelf lives in this browser only. The page is told when a game runs, pauses or leaves, so
  // its own card never lands on a running game.
  const isGuest = app.hello.guest === true;
  if (isGuest) root.dataset.guest = "true";
  const activity = createActivityReporter(isGuest ? (state) => activityApi.report(state) : null);
  let sync: SyncAccount | null = null;
  let syncProblem: SyncProblem | null = null;
  const stopSyncWatch: Array<() => void> = [];
  function adoptSync(open: { account: SyncAccount | null; problem: SyncProblem | null }) {
    for (const stop of stopSyncWatch.splice(0)) stop();
    sync = open.account;
    syncProblem = open.problem;
    const state = sync ? sync.mode : syncProblem;
    if (state) root.dataset.sync = state;
    else delete root.dataset.sync;
    // what the account holds changes as saves go up: the line under the meter follows
    if (sync) stopSyncWatch.push(sync.onChange(() => topBar?.update({ cloud: cloudChip() })));
  }
  if (!isSpectator && !isGuest) adoptSync(await openSync(syncApi, store));
  /** What the shelf says about the account: its usage, or why it is not working, or nothing where the feature is off. */
  function cloudChip(): CloudChip | null {
    if (sync) return { state: sync.mode, used: sync.usage.used, cap: sync.usage.cap };
    return syncProblem ? { state: syncProblem } : null;
  }

  // ---- "Levar pra outro aparelho": the export and import dialog, and the one toaster the Balcão has ----
  const exportDialog = createExportDialog({
    t,
    store,
    // the host hands the person the file; the name is theirs to pick there
    saveLocal: (bytes, ext) => app.files.saveLocal(bytes, ext),
    onImported: () => void refreshBalcao(),
    // with the account on, the file is only needed for the cartridge, and the sheet says so
    savesOnAccount: () => sync?.mode === "on",
    // "Importar de um arquivo": the same host picker as Botar fita, but only a .locadora goes on from here
    pickBundle: async () => {
      const picked = await pickTape(app);
      if (picked.kind === "bundle") return { kind: "bundle", bytes: picked.bytes };
      return picked.kind === "cancelled" ? { kind: "cancelled" } : { kind: "other" };
    },
  });
  const balcaoToaster = createToaster();
  /** "Tentar de novo", on the shelf: asks the account again and says what came of it. */
  let retryingSync = false;
  async function retrySync() {
    if (retryingSync || isSpectator || isGuest) return;
    retryingSync = true;
    balcaoToaster.show({ text: t["sync.retrying"] });
    try {
      adoptSync(await openSync(syncApi, store));
      balcaoToaster.show({ text: sync ? t["sync.back"] : t["sync.stillDown"] });
      await refreshBalcao();
    } finally {
      retryingSync = false;
    }
  }
  // its own class, not `loc-toasts`: the game's toaster owns that one, and a test (or a person's stylesheet) finds it by name
  balcaoToaster.element.className = "loc-shelf-toasts";
  document.body.append(balcaoToaster.element);

  function applyLabels() {
    setText("title", t.title);
    setText("loading", t["load.steps"].split("·")[0]?.trim() ?? t.loading);
    shareButton.textContent = sharing ? t.shareStop : t.share;
    setText("notices-title", t.noticesTitle);
    setText("notices-intro", t.noticesIntro);
    noticesClose.textContent = t.noticesHide;
    setText("watching-title", t.watchingTitle);
    setText("watching-how", t.watchingHow);
    gameEl.setAttribute("aria-label", t.frameTitle);
    syncShare();
  }

  // ---- the stage and the game on it ----
  // Assigned once, further down, after the callbacks that read it exist.
  // eslint-disable-next-line prefer-const
  let session: GameSession;
  const screenStage = createStage({ stage: stageEl, game: gameEl, settings: keeper.prefs.stage, onLayout: () => session?.syncStage() });
  screenStage.onChange((settings) => keeper.update({ stage: { ...settings } }));

  // The host fullscreens the iframe element, not us: the emulator's own button cannot (allow="").
  let isFullscreen = false;
  function setFullscreenState(full: boolean) {
    if (full === isFullscreen) return;
    isFullscreen = full;
    root.dataset.fullscreen = String(full);
    screenStage.setFullscreen(full);
    session?.setFullscreen(full);
  }
  const fullscreenTracker = createFullscreenTracker();
  /** The host's answer is the truth; the next frames re-measure, since the window can still be on its way to its size. */
  function hostSaidFullscreen(on: boolean) {
    setFullscreenState(fullscreenTracker.hostSaid(on, viewportProbe()));
    settle();
  }
  async function askFullscreen(on: boolean) {
    hostSaidFullscreen(await app.ui.fullscreen(on));
  }
  async function toggleFullscreen() {
    try {
      await askFullscreen(!isFullscreen);
    } catch {
      // the host said no (or the session ended): nothing changes
    }
  }
  // Esc and the host's own exit change the size without any click of ours, so the size is what tells.
  const relayout = () => setFullscreenState(fullscreenTracker.judge(viewportProbe()));
  /** Two frames on, once the layout of the new size has settled, look again (and size the picture again). */
  function settle() {
    requestAnimationFrame(() => {
      relayout();
      screenStage.relayout();
      requestAnimationFrame(() => {
        relayout();
        screenStage.relayout();
      });
    });
  }
  new ResizeObserver(relayout).observe(stageEl);
  window.addEventListener("resize", () => {
    relayout();
    settle();
  });

  // ---- the controller map: first visit, the top bar's Controles and the HUD's F1 (src/onboarding.ts) ----
  let onboarding: Onboarding | null = null;

  function mountMap(options: {
    steps?: readonly Step[];
    platform?: Platform;
    replay?: boolean;
    onDone: (reason: "pick" | "skip" | "close") => void;
    onPick: () => void;
    onReplay?: () => void;
  }) {
    onboarding?.destroy();
    const dialog = mountOnboarding({
      root: onboardingSection,
      t,
      store,
      ...(options.steps ? { steps: options.steps } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.replay ? { replay: true } : {}),
      keymaps: keeper.prefs.keymaps,
      onKeymap: (platform, map) => {
        keeper.update({ keymaps: { ...keeper.prefs.keymaps, [platform]: { ...map } } });
        session.applyKeymap(platform, map);
      },
      onPick: options.onPick,
      ...(options.onReplay ? { onReplay: options.onReplay } : {}),
      onDone: (reason) => {
        onboarding = null;
        options.onDone(reason);
      },
    });
    onboarding = dialog;
    return dialog;
  }

  /**
   * The first visit's two screens, from the top. It is what a new device shows (the default) and what "Ver a recepção
   * de novo" shows (`replay`: no flag written, no "only the first time" line). `back` is where the keyboard returns.
   */
  function showWelcome(options: { replay?: boolean; back?: "pick" | "welcome" } = {}) {
    const walkthrough = mountMap({
      platform: "nes",
      ...(options.replay ? { replay: true } : {}),
      onPick: () => void pick(),
      onDone: (reason) => {
        // "pick" goes straight to the picker: the Balcão is drawn when that is answered
        if (reason === "pick") return;
        void showBalcao().then(() => (options.back === "welcome" ? topBar?.focusWelcome() : topBar?.pickButton.focus({ preventScroll: true })));
      },
    });
    show("onboarding");
    // the section was hidden while the panel was mounted, which cannot take focus
    walkthrough.focus();
  }

  function openControlsFromShelf() {
    const dialog = mountMap({
      steps: [3],
      onPick: () => {},
      // the shelf is drawn again, so the button that opened the map is a new one: the keyboard goes back to it
      onDone: () => void showBalcao().then(() => topBar?.focusControls()),
      onReplay: () => showWelcome({ replay: true }),
    });
    show("onboarding");
    // the section was hidden while the map was mounted, which cannot take focus
    dialog.focus();
  }

  function openControlsOverGame(platform: Platform, onClosed: () => void) {
    onboardingSection.dataset.overlay = "game";
    onboardingSection.hidden = false;
    const dialog = mountMap({
      steps: [3],
      platform,
      onPick: () => {},
      onDone: () => {
        delete onboardingSection.dataset.overlay;
        onboardingSection.hidden = true;
        onClosed();
      },
    });
    dialog.focus();
  }

  // ---- sharing the pane and watching it: built dark behind `locadora_share` (src/share.ts) ----
  const isWatcher = app.hello.self.role === "spectator";
  let shareAvailable = false;
  let sharing = false;
  function syncShare() {
    const playing = root.dataset.view === "palco";
    shareButton.hidden = !(shareAvailable && playing);
    bar.hidden = shareButton.hidden;
    shareButton.textContent = sharing ? t.shareStop : t.share;
    shareButton.setAttribute("aria-pressed", String(sharing));
    sharingLine.hidden = !(sharing && playing);
    sharingLine.textContent = sharing ? t.sharing : "";
  }
  screens.onChange(() => syncShare());
  shareButton.addEventListener("click", async () => {
    shareButton.disabled = true;
    const outcome = await setShared(app, !sharing);
    shareButton.disabled = false;
    if (outcome.kind === "shared") {
      sharing = outcome.on;
    } else {
      sharingLine.hidden = false;
      sharingLine.textContent = outcome.kind === "refused" ? t.shareRefused : t.shareFailed;
      if (outcome.kind === "refused") shareAvailable = false;
    }
    syncShare();
  });

  /** The line a watcher reads: whose game is on the screen they are looking at. */
  function renderWatching(roster: Awaited<ReturnType<PqpApp["participants"]["get"]>>) {
    const { shown, more } = spectatorNames(roster);
    const line = el("watching-line");
    if (shown.length === 0) {
      line.textContent = t.watchingEmpty;
      return;
    }
    const moreText = more > 0 ? t.watchingMore.split("{n}").join(String(more)) : "";
    line.textContent = t.watchingLine.split("{names}").join(shown.join(", ") + moreText);
  }

  // ---- the third-party notices, from the bundle (an asset: the frame cannot fetch, and cannot open a link) ----
  let noticesLoaded = false;
  let noticesOpener: Element | null = null;
  async function openNotices() {
    noticesOpener = document.activeElement;
    noticesPanel.hidden = false;
    noticesClose.focus();
    if (noticesLoaded) return;
    noticesText.textContent = t.noticesLoading;
    const text = await loadNotices(app);
    noticesLoaded = text !== null;
    noticesText.textContent = text ?? t.noticesFailed;
  }
  closeNotices = () => {
    if (noticesPanel.hidden) return;
    noticesPanel.hidden = true;
    if (noticesOpener instanceof HTMLElement && noticesOpener.isConnected) noticesOpener.focus();
    noticesOpener = null;
  };
  noticesClose.addEventListener("click", closeNotices);
  noticesPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeNotices();
    }
  });

  // ---- the Balcão: the sign, the top bar, Continuar, Regras da casa and the shelf (SPEC 4.1) ----
  let filter: ShelfFilter = "all";
  let sort: ShelfSort = "recent";
  let selectedSha: string | undefined;
  let topBar: TopBar | null = null;
  let shelf: Shelf | null = null;
  let counter: HTMLElement | null = null;
  let counterThumb: string | null = null;
  let problem: { text: string; hint: string; action?: { label: string; run: () => void } } | null = null;
  let busy = false;
  let ended = false;
  /** The device refused the last cartridge for lack of room: the shelf says so until something is removed or one fits. */
  let noRoom = false;

  /** A problem's headline and the line under it that says what to do. */
  const problemText = (kind: TapeProblem): { text: string; hint: string } =>
    ({
      unsupported: { text: t.problemUnsupported, hint: t.problemUnsupportedHint },
      "too-big": { text: t.problemTooBig, hint: t.problemTooBigHint },
      invalid: { text: t.problemInvalid, hint: t.problemInvalidHint },
      load: { text: t.problemLoad, hint: t.problemLoadHint },
    })[kind];

  async function readUsage() {
    try {
      const usage = await store.usage();
      return { used: usage.used, cap: usage.cap };
    } catch {
      return undefined;
    }
  }

  async function renderCounter(items: readonly LibraryItem[]) {
    if (!counter) return;
    if (counterThumb) URL.revokeObjectURL(counterThumb);
    counterThumb = null;
    const last = durable ? pickContinue(items) : null;
    const nodes: HTMLElement[] = [];
    if (last) {
      const at = last.slots.find((slot) => slot.slot === "auto")?.at;
      let thumbUrl: string | undefined;
      if (at !== undefined) {
        try {
          const row = await store.get(thumbKey(last.sha256, "auto"));
          if (row) {
            thumbUrl = URL.createObjectURL(new Blob([row.bytes as BlobPart], { type: "image/png" }));
            counterThumb = thumbUrl;
          }
        } catch {
          thumbUrl = undefined;
        }
      }
      const onAccount = sync ? (await gamesOnAccount(store)).has(last.sha256) : false;
      nodes.push(
        createContinueCard({
          item: last,
          t,
          now: Date.now(),
          onAccount,
          ...(at !== undefined ? { autosave: { at, ...(thumbUrl ? { thumbUrl } : {}) } } : {}),
          onContinue: (item) => void playItem(item, { continueAuto: at !== undefined }),
          onPickSave: (item) => void playItem(item, { drawer: true }),
        }),
      );
    }
    nodes.push(createHouseRules({ t, compact: last !== null, synced: sync !== null, guest: isGuest }).element);
    counter.replaceChildren(...nodes);
  }

  /**
   * What went wrong on the way in, as a card on the Balcão: a round badge, the headline, the line that says what to
   * do, the one action as the primary button, and a close button that puts the card away.
   */
  function problemBanner(): HTMLElement | null {
    if (!problem) return null;
    const close = h("button", { type: "button", class: "loc-problem-close", "aria-label": t.problemDismiss }, icon("close", 18));
    const banner = h(
      "div",
      { class: "loc-problem", role: "alert" },
      h("span", { class: "loc-problem-badge", "aria-hidden": "true" }, "!"),
      // the space between the two lines is for the text read as one (a screen reader, a search), not for the layout
      h("div", { class: "loc-problem-text" }, h("p", { class: "loc-problem-title" }, problem.text), " ", h("p", { class: "loc-problem-hint" }, problem.hint)),
    );
    if (problem.action) {
      const action = problem.action;
      const button = h("button", { type: "button", class: "loc-button loc-problem-action" }, action.label);
      button.addEventListener("click", action.run);
      banner.append(button);
    }
    close.addEventListener("click", () => {
      problem = null;
      const next = banner.parentElement?.querySelector<HTMLElement>(".loc-top-pick");
      banner.remove();
      next?.focus({ preventScroll: true });
    });
    banner.append(close);
    return banner;
  }

  async function showBalcao(focusSha?: string) {
    const [items, usage] = await Promise.all([loadLibrary(store).catch(() => [] as LibraryItem[]), readUsage()]);
    topBar = createTopBar({
      t,
      ...(durable && usage ? { usage } : {}),
      powerOn: consumePowerOn(),
      onPick: () => void pick(),
      onControls: openControlsFromShelf,
      onWelcome: () => showWelcome({ replay: true, back: "welcome" }),
      onExport: () => exportDialog.openExport(),
      onLicenses: () => void openNotices(),
      cloud: cloudChip(),
      onCloudRetry: () => void retrySync(),
    });
    counter = h("div", { class: "loc-counter" });
    await renderCounter(items);
    shelf = createShelf({
      t,
      items,
      storage: durable ? "ready" : "unavailable",
      ...(usage ? { usage } : {}),
      refused: noRoom,
      filter,
      sort,
      ...(selectedSha ? { selectedSha } : {}),
      onPlay: (item) => void playItem(item),
      onPick: () => void pick(),
      onSaves: (item) => void playItem(item, { drawer: true }),
      onAttach: (item) => void attachTape(item),
      onRename: (item, title) => void renameItem(store, item.sha256, title).then(refreshBalcao),
      onRemove: (item) =>
        void removeItem(store, item.sha256).then(
          () => {
            // something was taken off: whatever refused the last cartridge may fit it now
            noRoom = false;
            return refreshBalcao();
          },
          refreshBalcao,
        ),
      onSelect: (sha) => {
        selectedSha = sha;
      },
      onFilter: (next) => {
        filter = next;
      },
      onSort: (next) => {
        sort = next;
      },
    });
    shelfSection.replaceChildren(...[topBar.element, problemBanner(), counter, shelf.element].filter((node): node is HTMLElement => node !== null));
    show("balcao");
    // the shelf comes back at its top, wherever it was scrolled to before the game: the bar must be in view, not cut off.
    // (`#v-shelf` is what scrolls; the page itself never does.)
    shelfSection.scrollTop = 0;
    window.scrollTo(0, 0);
    if (focusSha) shelf.focus(focusSha, { preventScroll: true });
  }

  /** The shelf changed under the Balcão (a rename, a removal): redraw its parts without losing the focus. */
  async function refreshBalcao() {
    if (!shelf || !topBar) return;
    const [items, usage] = await Promise.all([loadLibrary(store).catch(() => [] as LibraryItem[]), readUsage()]);
    shelf.update({ items, ...(usage ? { usage } : {}), refused: noRoom });
    topBar.update({ usage: durable && usage ? usage : null, cloud: cloudChip() });
    await renderCounter(items);
  }

  // N puts a cartridge in, from the Balcão, unless a dialog is up or a field has the keys
  document.addEventListener("keydown", (event) => {
    if (screens.current !== "balcao" || !noticesPanel.hidden || !exportDialog.element.hidden || !isPickShortcut(event)) return;
    event.preventDefault();
    void pick();
  });

  // ---- putting a game on the stage ----
  session = createGameSession({
    app,
    t,
    locale: app.hello.locale,
    language: EMULATOR_LANGUAGE[lang],
    accent: app.hello.theme["--color-accent"],
    store,
    prefs: keeper,
    stage: screenStage,
    screens,
    elements: { play, stage: stageEl, game: gameEl },
    isFullscreen: () => isFullscreen,
    toggleFullscreen,
    openControls: openControlsOverGame,
    openExport: () => exportDialog.openExport(),
    // read at use, not copied: "Tentar de novo" on the shelf can bring the account back between two games
    get sync() {
      return sync;
    },
    get syncProblem() {
      return syncProblem;
    },
    onActivity: (state) => activity.report(state),
    onLeave: (_reason, item) => {
      activity.report("browsing");
      if (isFullscreen) {
        void askFullscreen(false).catch(() => undefined);
      }
      void showBalcao(item.sha256);
    },
  });

  /** The nearly-full disk (or a refusing one) is said once the game is up, on its own toast. */
  async function launch(input: GameInput, intent: StartIntent = {}) {
    problem = null;
    await session.start(input, intent);
  }

  async function pick() {
    if (ended || busy || session.playing) return;
    busy = true;
    problem = null;
    try {
      const outcome = await chooseTape(app, () => {
        loadingSection.hidden = false;
        show("loading");
      });
      if (outcome.kind === "cancelled") {
        if (screens.current !== "balcao") await showBalcao();
        return;
      }
      if (outcome.kind === "problem") {
        problem = { ...problemText(outcome.problem), action: { label: t["top.pick"], run: () => void pick() } };
        await showBalcao();
        return;
      }
      if (outcome.kind === "bundle") {
        // a `.locadora` file is saves from another device: it goes to the import dialog, never to the emulator
        if (screens.current !== "balcao") await showBalcao();
        void exportDialog.openImport(outcome.bytes);
        return;
      }
      const items = await loadLibrary(store).catch(() => [] as LibraryItem[]);
      const added = await addToLibrary(store, {
        bytes: new Uint8Array(outcome.rom),
        ext: outcome.ext,
        fallbackTitle: nextUntitledTitle(items, t["name.default"]),
      });
      if (!added) {
        problem = { ...problemText("unsupported"), action: { label: t["top.pick"], run: () => void pick() } };
        await showBalcao();
        return;
      }
      // a refusal is remembered for the shelf to say; a cartridge that fits (or is already there) clears it
      const refusedNow = added.isNew && !added.stored && durable;
      if (refusedNow) noRoom = true;
      else if (added.stored) noRoom = false;
      await launch(
        {
          item: added.item,
          rom: outcome.rom,
          core: outcome.core,
          ext: outcome.ext,
          coreData: outcome.coreData,
          report: outcome.report,
          askName: added.askName,
          isNew: added.isNew,
        },
        refusedNow ? { notice: t["err.storage"] } : {},
      );
    } catch {
      problem = { ...problemText("load"), action: { label: t["top.pick"], run: () => void pick() } };
      await showBalcao();
    } finally {
      busy = false;
    }
  }

  /**
   * "Falta a fita" (SPEC 11): a box that came in a bundle without its game file. The picker opens; a file whose hash
   * is the box's own sha is attached (and played), any other is refused with a toast, so a save is never opened by
   * the wrong game. A `.locadora` file picked here goes to the import dialog like anywhere else.
   */
  async function attachTape(item: LibraryItem) {
    if (ended || busy || session.playing) return;
    busy = true;
    problem = null;
    try {
      const picked = await pickTape(app);
      if (picked.kind === "cancelled") return;
      if (picked.kind === "problem") {
        problem = { ...problemText(picked.problem), action: { label: t["top.pick"], run: () => void pick() } };
        await showBalcao(item.sha256);
        return;
      }
      if (picked.kind === "bundle") {
        void exportDialog.openImport(picked.bytes);
        return;
      }
      const bytes = new Uint8Array(picked.bytes);
      const attached = await attachFile(store, item, bytes);
      if (!attached.ok) {
        balcaoToaster.show({ text: t["attach.mismatch"] });
        return;
      }
      const core = coreForExtension(item.ext);
      if (!core) {
        problem = problemText("unsupported");
        await showBalcao(item.sha256);
        return;
      }
      if (!attached.stored && durable) noRoom = true;
      loadingSection.hidden = false;
      show("loading");
      const files = await fetchCoreFiles(app, core);
      await launch(
        {
          item: { ...item, hasFile: true },
          rom: picked.bytes,
          core,
          ext: item.ext,
          coreData: files.coreData,
          report: files.report,
          askName: false,
        },
        attached.stored ? {} : { notice: t["err.storage"] },
      );
    } catch {
      problem = problemText("load");
      await showBalcao(item.sha256);
    } finally {
      busy = false;
    }
  }

  /** A box from the shelf: its file comes out of the device store, the core's files from the bundle. */
  async function playItem(item: LibraryItem, intent: StartIntent = {}) {
    if (ended || busy || session.playing) return;
    busy = true;
    problem = null;
    try {
      loadingSection.hidden = false;
      show("loading");
      const row = await store.get(romKey(item.sha256));
      const core = coreForExtension(item.ext);
      if (!row && core) {
        // "falta a fita": a box from a bundle, saves here and no game file. Ask for the file instead of failing.
        busy = false;
        await showBalcao(item.sha256);
        await attachTape(item);
        return;
      }
      if (!row || !core) {
        problem = problemText("load");
        await showBalcao();
        return;
      }
      const files = await fetchCoreFiles(app, core);
      const rom = row.bytes.buffer.slice(row.bytes.byteOffset, row.bytes.byteOffset + row.bytes.byteLength) as ArrayBuffer;
      await launch({ item, rom, core, ext: item.ext, coreData: files.coreData, report: files.report, askName: false }, intent);
    } catch {
      problem = problemText("load");
      await showBalcao();
    } finally {
      busy = false;
    }
  }

  const showConnection = (status: "online" | "reconnecting") => {
    statusLine.textContent = status === "online" ? "" : t.reconnecting;
    root.dataset.connection = status;
  };
  showConnection(app.connection);
  app.on("connection", showConnection);
  app.on("ended", () => {
    ended = true;
    sharing = false;
    statusLine.textContent = "";
    endedLine.textContent = sync ? t["ended.synced"] : t.ended;
    show("ended");
    void session.end();
  });

  // flush what is waiting when the page is leaving, so a key rebound a moment ago is not lost
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) void keeper.flush();
  });

  applyLabels();
  if (isWatcher) {
    // a watcher has no game of their own to pick: they see the share, and this line says whose it is
    app.participants.on(renderWatching);
    renderWatching(await app.participants.get());
    show("watching");
    return;
  }

  if (welcomeForced(location.search)) {
    // ?welcome=1: a replay on load, the stored flag untouched
    showWelcome({ replay: true });
  } else if (await shouldShowOnboarding(store)) {
    showWelcome();
  } else {
    await showBalcao();
  }
  activity.report("browsing");
  // a guest has no call to share into, and the host would refuse: no probe
  if (isGuest) return;
  // one stop request tells whether the platform offers sharing here (see src/share.ts)
  shareAvailable = await probeShare(app);
  syncShare();
}

void main();
