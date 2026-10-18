/*
 * The page inside the emulator room's frame. Plain script on purpose: it is
 * served as a static file next to frame.html, whose policy forbids inline code.
 *
 * WHAT IT DOES WITH THE GAME FILE: receives a `File` from the page that opened
 * the frame (a same-origin postMessage; the bytes stay in this browser's
 * memory), hands that very object to the emulator, and never does anything else
 * with it. No fetch, no XHR, no upload, no storage, no log of its name. The
 * emulator's databases are switched off below so it keeps nothing either.
 *
 * It trusts one sender only: the window that embedded it, from its own origin.
 */
(function () {
  "use strict";

  var DATA_PATH = "/emulator/ejs/";

  /**
   * file extension -> the EmulatorJS core. The names are the emulator's own
   * core names; only the two cores this site ships are listed (see
   * client/src/lib/emulator-assets.ts), because asking for any other would
   * fetch a file that is not there.
   */
  var CORE_BY_EXTENSION = {
    nes: "fceumm",
    gb: "mgba",
    gbc: "mgba",
    gba: "mgba",
  };

  var LANGUAGES = { "es-ES": true, "pt-BR": true };

  var started = false;

  function boot(file, language) {
    if (started) {
      return;
    }
    var name = typeof file.name === "string" ? file.name : "";
    var dot = name.lastIndexOf(".");
    var extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    var core = CORE_BY_EXTENSION[extension];
    if (!core) {
      window.parent.postMessage({ type: "pqp-emulator-error", reason: "unsupported" }, window.location.origin);
      return;
    }
    started = true;

    window.EJS_player = "#game";
    window.EJS_core = core;
    window.EJS_pathtodata = DATA_PATH;
    // The picked file itself, not a URL to it: the emulator reads it from
    // memory. The name only carries the extension the core looks at; it is a
    // fixed word, never what the player called the file.
    window.EJS_gameUrl = file;
    window.EJS_gameName = "rom." + extension;
    window.EJS_startOnLoaded = false;
    window.EJS_threads = false;
    window.EJS_volume = 0.5;
    window.EJS_language = LANGUAGES[language] ? language : "en-US";
    window.EJS_disableAutoLang = false;
    // Nothing is kept: no rom, bios or core cache in IndexedDB, no settings in
    // localStorage. The save-state and file buttons that would write somewhere
    // (or download something) are hidden; local play only.
    window.EJS_disableDatabases = true;
    window.EJS_disableLocalStorage = true;
    window.EJS_Buttons = {
      saveState: false,
      loadState: false,
      quickSave: false,
      quickLoad: false,
      saveSavFiles: false,
      loadSavFiles: false,
      cacheManager: false,
      screenRecord: false,
      cheat: false,
      netplay: false,
      exitEmulation: false,
      diskButton: false,
    };

    var script = document.createElement("script");
    script.src = DATA_PATH + "loader.js";
    script.onerror = function () {
      window.parent.postMessage({ type: "pqp-emulator-error", reason: "load" }, window.location.origin);
    };
    document.head.appendChild(script);
    window.parent.postMessage({ type: "pqp-emulator-started" }, window.location.origin);
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin || event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== "pqp-emulator-load" || !(data.file instanceof File)) {
      return;
    }
    boot(data.file, typeof data.language === "string" ? data.language : "en-US");
  });

  // Tell the page that opened us we can take a file now.
  window.parent.postMessage({ type: "pqp-emulator-ready" }, window.location.origin);
})();
