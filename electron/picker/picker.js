/**
 * The share picker's renderer.
 *
 * No framework, no bundler, no imports: this page ships inside the app bundle
 * and has to work on the very first paint, before any network exists. Every
 * string arrives from the main process (`electron/locales/`), because this
 * window cannot reach the web client's i18next instance.
 *
 * Every node is built with `document.createElement` and `textContent`.
 * Window titles are attacker-influenced in the ordinary sense (anyone can name
 * a window anything), so none of them is ever interpolated into HTML.
 */

const bridge = window.pqpPicker;

/** @type {Array<{id: string, kind: string, label: string, thumbnail: string|null, appIcon: string|null}>} */
let sources = [];
/** @type {string|null} */
let selectedId = null;
/** Guards against a second answer after the window starts closing. */
let answered = false;

const el = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  screens: document.getElementById("screens"),
  screensLabel: document.getElementById("screens-label"),
  screensGrid: document.getElementById("screens-grid"),
  windows: document.getElementById("windows"),
  windowsLabel: document.getElementById("windows-label"),
  windowsGrid: document.getElementById("windows-grid"),
  empty: document.getElementById("empty"),
  cancel: document.getElementById("cancel"),
  confirm: document.getElementById("confirm"),
};

function cancel() {
  if (answered) {
    return;
  }
  answered = true;
  bridge.cancel();
}

function shareSelected() {
  if (answered || !selectedId) {
    return;
  }
  answered = true;
  bridge.choose(selectedId);
}

function select(id) {
  selectedId = id;
  for (const tile of document.querySelectorAll(".tile")) {
    tile.setAttribute("aria-pressed", String(tile.dataset.id === id));
  }
  el.confirm.disabled = !id;
}

function buildTile(source, strings) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "tile";
  tile.dataset.id = source.id;
  tile.setAttribute("aria-pressed", "false");

  const shot = document.createElement("div");
  shot.className = "shot";
  if (source.thumbnail) {
    const img = document.createElement("img");
    img.src = source.thumbnail;
    img.alt = "";
    shot.append(img);
  } else {
    // A thumbnail is missing far more often than it looks: minimized windows
    // and, on macOS, everything at all until screen recording is granted.
    // Saying so beats an empty grey box the user reads as a broken app.
    const note = document.createElement("p");
    note.className = "no-preview";
    note.textContent = strings.noPreview;
    shot.append(note);
  }
  tile.append(shot);

  const label = document.createElement("div");
  label.className = "label";
  if (source.appIcon) {
    const icon = document.createElement("img");
    icon.src = source.appIcon;
    icon.alt = "";
    label.append(icon);
  }
  const text = document.createElement("span");
  const name = source.label;
  text.textContent = name;
  // Titles are routinely wider than a tile. The tooltip is the only way to
  // read the rest of "Documento sem titulo 1 - Google Docs - Chrome".
  tile.title = name;
  label.append(text);
  tile.append(label);

  tile.addEventListener("click", () => select(source.id));
  tile.addEventListener("dblclick", () => {
    select(source.id);
    shareSelected();
  });
  return tile;
}

/** Arrow keys walk the whole list, across the screens/windows boundary. */
function moveSelection(step) {
  if (sources.length === 0) {
    return;
  }
  const current = sources.findIndex((s) => s.id === selectedId);
  const next = current < 0 ? 0 : (current + step + sources.length) % sources.length;
  select(sources[next].id);
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(sources[next].id)}"]`);
  if (tile) {
    tile.focus();
    tile.scrollIntoView({ block: "nearest" });
  }
}

function render(payload) {
  const strings = payload.strings;
  sources = payload.sources;

  document.documentElement.setAttribute("data-theme", payload.dark ? "dark" : "light");
  document.title = strings.title;
  el.title.textContent = strings.title;
  el.subtitle.textContent = strings.subtitle;
  el.screensLabel.textContent = strings.groupScreens;
  el.windowsLabel.textContent = strings.groupWindows;
  el.cancel.textContent = strings.cancel;
  el.confirm.textContent = strings.confirm;
  el.empty.textContent = strings.empty;

  const screens = sources.filter((s) => s.kind === "screen");
  const windows = sources.filter((s) => s.kind === "window");

  for (const source of screens) {
    el.screensGrid.append(buildTile(source, strings));
  }
  for (const source of windows) {
    el.windowsGrid.append(buildTile(source, strings));
  }

  el.screens.hidden = screens.length === 0;
  el.windows.hidden = windows.length === 0;
  el.empty.hidden = sources.length > 0;

  // Preselect the first surface, which is the primary display. Someone with
  // one monitor who just wants to share it presses Enter and is done: the
  // picker costs them a keystroke, not a hunt.
  if (sources.length > 0) {
    select(sources[0].id);
    el.confirm.focus();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key === "Enter" && document.activeElement !== el.cancel) {
    event.preventDefault();
    shareSelected();
    return;
  }
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  }
});

el.cancel.addEventListener("click", cancel);
el.confirm.addEventListener("click", shareSelected);

// A window closed by its own titlebar button never reaches this script, so the
// cancel path lives in the main process too. This only covers the reload case.
window.addEventListener("beforeunload", cancel);

bridge
  .load()
  .then((payload) => {
    render(payload);
    // Last: telling main we are alive before the list is on screen would let
    // it cancel the load timer for a window that then throws while rendering.
    bridge.ready();
  })
  .catch(() => {
    // Nothing to show and no way to say why in a language we do not have.
    // Cancel cleanly; the client turns that into "screen share cancelled",
    // which is at least the truth.
    cancel();
  });
