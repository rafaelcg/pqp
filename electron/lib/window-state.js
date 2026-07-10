const fs = require("node:fs");
const path = require("node:path");
const { screen } = require("electron");

const DEFAULTS = {
  width: 1280,
  height: 800,
  minWidth: 900,
  minHeight: 600,
};

function statePath(userDataPath) {
  return path.join(userDataPath, "window-state.json");
}

function loadWindowState(userDataPath) {
  try {
    const raw = fs.readFileSync(statePath(userDataPath), "utf8");
    const saved = JSON.parse(raw);
    if (!isVisibleOnDisplay(saved)) {
      return { ...DEFAULTS };
    }
    return {
      ...DEFAULTS,
      ...saved,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function isVisibleOnDisplay(state) {
  if (
    typeof state?.x !== "number" ||
    typeof state?.y !== "number" ||
    typeof state?.width !== "number" ||
    typeof state?.height !== "number"
  ) {
    return true;
  }

  const bounds = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };

  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

function trackWindowState(win, userDataPath) {
  let saveTimer = null;

  function scheduleSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) {
        return;
      }
      const bounds = win.getBounds();
      const payload = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: win.isMaximized(),
      };
      try {
        fs.writeFileSync(statePath(userDataPath), JSON.stringify(payload));
      } catch {
        // Ignore persistence failures (disk full, permissions, etc.)
      }
    }, 300);
  }

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("close", scheduleSave);
}

module.exports = {
  DEFAULTS,
  loadWindowState,
  trackWindowState,
};
