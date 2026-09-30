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
/** What the sound row shows for each state: `audio-state.js`, loaded first. */
const audio = window.pqpPickerAudio;
/** The strings the last `render()` was handed, for redrawing the sound row. */
let currentStrings = {};

/** @type {Array<{id: string, kind: string, label: string, thumbnail: string|null, appIcon: string|null}>} */
let sources = [];
/** @type {string|null} */
let selectedId = null;
/** Guards against a second answer after the window starts closing. */
let answered = false;
/**
 * `"hidden"` (mac/Linux, no sound to talk about), `"checkbox"` (Windows: a
 * real choice, a switch that starts ON) or `"explain"` (Windows 10 without
 * the native capture, where the switch would be a lie). Set once per
 * `render()`, from `pickerAudioState` in main.
 * @type {"hidden"|"checkbox"|"explain"}
 */
let audioState = "hidden";

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
  audioRow: document.getElementById("audio-row"),
  shareAudio: document.getElementById("share-audio"),
  audioLabel: document.getElementById("audio-label"),
  audioHint: document.getElementById("audio-hint"),
  audioNote: document.getElementById("audio-note"),
  cancel: document.getElementById("cancel"),
  confirm: document.getElementById("confirm"),
};

function shareAudioChecked() {
  return Boolean(el.shareAudio && el.shareAudio.checked);
}

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
  bridge.choose(selectedId, shareAudioChecked());
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

/**
 * Draws the sound row from `audio-state.js`'s answer for the current state.
 *
 * Three shapes, not a hidden/shown toggle: see the `audioState` doc comment
 * up top for why a hidden row on Windows 10 was the bug, not a simplification.
 */
function applyAudioView(view) {
  el.audioRow.hidden = !view.visible;
  el.audioRow.classList.toggle("is-off", view.icon === "off");
  el.audioRow.classList.toggle("no-switch", !view.hasSwitch);
  el.shareAudio.hidden = !view.hasSwitch;
  el.shareAudio.disabled = !view.hasSwitch;
  el.shareAudio.checked = view.checked;
  el.audioLabel.textContent = view.label;
  el.audioHint.textContent = view.hint;
  el.audioNote.textContent = view.note;
  el.audioNote.hidden = view.note === "";
}

function renderAudioRow(strings) {
  currentStrings = strings;
  // "checkbox" starts ON, every time the picker opens (`defaultAudioChecked`):
  // what the person did with it last time is not remembered on purpose, so a
  // share never starts silent because of an earlier one. Nothing starts from
  // here: the value rides on `choose()` when they press Share, and not before.
  applyAudioView(
    audio.audioRowView(audioState, audio.defaultAudioChecked(audioState), strings),
  );
}

function render(payload) {
  const strings = payload.strings;
  sources = payload.sources;
  audioState =
    payload.audioState === "checkbox" || payload.audioState === "explain"
      ? payload.audioState
      : "hidden";

  document.documentElement.setAttribute("data-theme", payload.dark ? "dark" : "light");
  document.title = strings.title;
  el.title.textContent = strings.title;
  el.subtitle.textContent = strings.subtitle;
  el.screensLabel.textContent = strings.groupScreens;
  el.windowsLabel.textContent = strings.groupWindows;
  el.cancel.textContent = strings.cancel;
  el.confirm.textContent = strings.confirm;
  el.empty.textContent = strings.empty;
  renderAudioRow(strings);

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

// Turning the sound off says what that means right away, in the row itself.
el.shareAudio.addEventListener("change", () => {
  applyAudioView(audio.audioRowView(audioState, el.shareAudio.checked, currentStrings));
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
