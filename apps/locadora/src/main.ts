import "./shim";
import "@emulatorjs/emulatorjs/data/emulator.css";
import "./style.css";
import { applyTheme, connect, type PqpApp } from "@pqp/app-sdk";
import { EMULATOR_LANGUAGE, pickLocale, STRINGS, type Strings } from "./i18n";
import { startEmulator, stopEmulator } from "./emulator";
import { chooseTape, type TapeProblem } from "./tape";

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
const problemLine = el<HTMLElement>("problem");
const startHint = el<HTMLElement>("start-hint");
const endedLine = el<HTMLElement>("ended");

type Screen = "connecting" | "shelf" | "loading" | "playing" | "outside";

function show(screen: Screen) {
  root.dataset.view = screen;
  shelf.hidden = screen !== "shelf";
  loading.hidden = screen !== "loading";
  play.hidden = screen !== "playing";
  bar.hidden = screen === "connecting" || screen === "outside";
  chooseAnother.hidden = screen !== "playing";
  fullscreenButton.hidden = screen !== "playing";
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
    el("game").setAttribute("aria-label", t.frameTitle);
    syncControls();
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
    statusLine.textContent = "";
    endedLine.textContent = t.ended;
    endedLine.hidden = false;
    shelf.hidden = true;
    loading.hidden = true;
    play.hidden = true;
    bar.hidden = true;
    controlsPanel.hidden = true;
  });

  applyLabels();
  show("shelf");
}

void main();
