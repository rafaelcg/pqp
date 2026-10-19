import "./shim";
import "@emulatorjs/emulatorjs/data/emulator.css";
import "./style.css";
import { applyTheme, connect, type PqpApp } from "@pqp/app-sdk";
import { EMULATOR_LANGUAGE, pickLocale, STRINGS, type Strings } from "./i18n";
import { startEmulator, stopEmulator } from "./emulator";
import { probeShare, setShared, spectatorNames } from "./share";
import { chooseTape, loadNotices, type TapeProblem } from "./tape";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const root = el<HTMLElement>("loc");
const statusLine = el<HTMLElement>("status");
const shelf = el<HTMLElement>("v-shelf");
const loading = el<HTMLElement>("v-loading");
const play = el<HTMLElement>("v-play");
const bar = el<HTMLElement>("bar");
const chooseButton = el<HTMLButtonElement>("choose");
const chooseAnother = el<HTMLButtonElement>("choose-another");
const fullscreenButton = el<HTMLButtonElement>("fullscreen");
const controlsToggle = el<HTMLButtonElement>("controls-toggle");
const controlsPanel = el<HTMLElement>("controls");
const watchView = el<HTMLElement>("v-watch");
const shareButton = el<HTMLButtonElement>("share");
const sharingLine = el<HTMLElement>("sharing");
const noticesToggle = el<HTMLButtonElement>("notices-toggle");
const noticesPanel = el<HTMLElement>("notices");
const noticesText = el<HTMLElement>("notices-text");
const problemLine = el<HTMLElement>("problem");
const startHint = el<HTMLElement>("start-hint");
const endedLine = el<HTMLElement>("ended");

type Screen = "connecting" | "shelf" | "loading" | "playing" | "watching" | "outside";

function show(screen: Screen) {
  root.dataset.view = screen;
  shelf.hidden = screen !== "shelf";
  loading.hidden = screen !== "loading";
  play.hidden = screen !== "playing";
  watchView.hidden = screen !== "watching";
  bar.hidden = screen === "connecting" || screen === "outside";
  chooseAnother.hidden = screen !== "playing";
  fullscreenButton.hidden = screen !== "playing";
  if (screen !== "playing") {
    // the share control and its line belong to the game on screen (`syncShare` brings them back)
    shareButton.hidden = true;
    sharingLine.hidden = true;
  }
}

function setText(id: string, text: string) {
  el(id).textContent = text;
}

async function main() {
  let t: Strings = STRINGS[pickLocale(navigator.language || "en")];
  let lang = pickLocale(navigator.language || "en");
  document.documentElement.lang = lang;
  statusLine.textContent = t.connecting;
  show("connecting");

  let app: PqpApp;
  try {
    app = await connect();
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
  applyTheme(app.hello.theme);
  app.on("theme", (theme) => applyTheme(theme));

  function applyLabels() {
    setText("title", t.title);
    setText("intro", t.intro);
    setText("privacy", t.privacy);
    setText("rights", t.rights);
    setText("systems", t.systems);
    setText("solo", t.solo);
    setText("loading", t.loading);
    setText("start-hint", t.startHint);
    chooseButton.textContent = t.choose;
    chooseAnother.textContent = t.chooseAnother;
    setText("control-dpad", t.controlDpad);
    setText("control-a", t.controlA);
    setText("control-b", t.controlB);
    setText("control-start", t.controlStart);
    setText("control-select", t.controlSelect);
    setText("control-shoulders", t.controlShoulders);
    setText("control-gamepad", t.controlGamepad);
    setText("notices-intro", t.noticesIntro);
    setText("watching-title", t.watchingTitle);
    setText("watching-how", t.watchingHow);
    syncShare();
    el("game").setAttribute("aria-label", t.frameTitle);
    syncControls();
    syncNotices();
    syncFullscreen();
  }

  let controlsOpen = false;
  function syncControls() {
    controlsPanel.hidden = !controlsOpen;
    controlsToggle.setAttribute("aria-expanded", String(controlsOpen));
    controlsToggle.textContent = controlsOpen ? t.controlsHide : t.controlsTitle;
  }
  controlsToggle.addEventListener("click", () => {
    controlsOpen = !controlsOpen;
    syncControls();
  });

  // ---- sharing the pane and watching it: built dark behind `locadora_share` (src/share.ts) ----
  const isWatcher = app.hello.self.role === "spectator";
  let shareAvailable = false;
  let sharing = false;
  function syncShare() {
    const playing = root.dataset.view === "playing";
    shareButton.hidden = !(shareAvailable && playing);
    shareButton.textContent = sharing ? t.shareStop : t.share;
    shareButton.setAttribute("aria-pressed", String(sharing));
    sharingLine.hidden = !(sharing && playing);
    sharingLine.textContent = sharing ? t.sharing : "";
  }
  shareButton.addEventListener("click", async () => {
    shareButton.disabled = true;
    const outcome = await setShared(app, !sharing);
    shareButton.disabled = false;
    if (outcome.kind === "shared") {
      sharing = outcome.on;
      showProblem(null);
    } else {
      showShareProblem(outcome.kind === "refused" ? t.shareRefused : t.shareFailed);
      if (outcome.kind === "refused") shareAvailable = false;
    }
    syncShare();
  });
  function showShareProblem(text: string) {
    sharingLine.hidden = false;
    sharingLine.textContent = text;
  }

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

  // The third-party notices, from the bundle (an asset: the frame cannot fetch, and cannot open a link).
  let noticesOpen = false;
  let noticesLoaded = false;
  function syncNotices() {
    noticesPanel.hidden = !noticesOpen;
    noticesToggle.setAttribute("aria-expanded", String(noticesOpen));
    noticesToggle.textContent = noticesOpen ? t.noticesHide : t.noticesTitle;
  }
  noticesToggle.addEventListener("click", async () => {
    noticesOpen = !noticesOpen;
    syncNotices();
    if (!noticesOpen || noticesLoaded) return;
    noticesText.textContent = t.noticesLoading;
    const text = await loadNotices(app);
    noticesLoaded = text !== null;
    noticesText.textContent = text ?? t.noticesFailed;
  });

  // The host fullscreens the iframe element, not us: the emulator's own button cannot (allow="").
  let isFullscreen = false;
  function syncFullscreen() {
    fullscreenButton.textContent = isFullscreen ? t.exitFullscreen : t.fullscreen;
  }
  fullscreenButton.addEventListener("click", async () => {
    try {
      isFullscreen = await app.ui.fullscreen(!isFullscreen);
    } catch {
      // the host said no (or the session ended): nothing changes
    }
    syncFullscreen();
  });

  const problemText = (problem: TapeProblem): string =>
    ({ unsupported: t.problemUnsupported, "too-big": t.problemTooBig, load: t.problemLoad })[problem];

  function showProblem(problem: TapeProblem | null) {
    problemLine.hidden = problem === null;
    problemLine.textContent = problem === null ? "" : problemText(problem);
  }

  let ended = false;
  let playing = false;

  async function pick() {
    if (ended) return;
    chooseButton.disabled = true;
    chooseAnother.disabled = true;
    try {
      const outcome = await chooseTape(app, () => {
        // a game that is running keeps running until the new one is ready
        if (!playing) show("loading");
      });
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "problem") {
        if (playing) return; // the game that is running keeps running
        showProblem(outcome.problem);
        show("shelf");
        return;
      }
      showProblem(null);
      if (playing) stopEmulator();
      // the emulator draws into #game, and a hidden element has no size to draw into
      show("playing");
      syncShare();
      playing = true;
      startHint.hidden = false;
      startEmulator({
        container: "#game",
        core: outcome.core,
        ext: outcome.ext,
        rom: outcome.rom,
        coreData: outcome.coreData,
        report: outcome.report,
        language: EMULATOR_LANGUAGE[lang],
        accent: app.hello.theme["--color-accent"],
        onStart: () => {
          startHint.hidden = true;
        },
        onError: () => {
          stopEmulator();
          playing = false;
          showProblem("load");
          show("shelf");
        },
      });
    } catch {
      playing = false;
      showProblem("load");
      show("shelf");
    } finally {
      chooseButton.disabled = false;
      chooseAnother.disabled = false;
    }
  }
  chooseButton.addEventListener("click", () => void pick());
  chooseAnother.addEventListener("click", () => void pick());

  const showConnection = (status: "online" | "reconnecting") => {
    statusLine.textContent = status === "online" ? t.online : t.reconnecting;
    root.dataset.connection = status;
  };
  showConnection(app.connection);
  app.on("connection", showConnection);
  app.on("ended", () => {
    ended = true;
    stopEmulator();
    playing = false;
    sharing = false;
    shareButton.hidden = true;
    sharingLine.hidden = true;
    watchView.hidden = true;
    statusLine.textContent = "";
    endedLine.textContent = t.ended;
    endedLine.hidden = false;
    shelf.hidden = true;
    loading.hidden = true;
    play.hidden = true;
    bar.hidden = true;
    controlsPanel.hidden = true;
    noticesPanel.hidden = true;
  });

  applyLabels();
  if (isWatcher) {
    // a watcher has no game of their own to pick: they see the share, and this line says whose it is
    app.participants.on(renderWatching);
    renderWatching(await app.participants.get());
    show("watching");
  } else {
    show("shelf");
    // one stop request tells whether the platform offers sharing here (see src/share.ts)
    shareAvailable = await probeShare(app);
    syncShare();
  }
}

void main();
