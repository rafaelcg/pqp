/*
 * The page inside the emulator room's frame. Plain script on purpose: it is
 * served as a static file next to frame.html, whose policy forbids inline code.
 *
 * WHAT IT DOES WITH THE GAME FILE: receives a `File` from the page that opened
 * the frame (a postMessage; the bytes stay in this browser's memory), hands that
 * very object to the emulator, and never does anything else with it. No fetch,
 * no XHR, no upload, no storage, no log of its name. The emulator's databases
 * are switched off below so it keeps nothing either.
 *
 * It trusts one sender only: the window that embedded it, from the origin that
 * embedded it (the page passes that origin as `?o=`).
 *
 * THE PAGE RUNS IN AN OPAQUE ORIGIN. The embedding iframe is
 * `sandbox="allow-scripts"` with no `allow-same-origin`, so whatever runs here,
 * the third-party emulator and whatever a hostile game file might make it do,
 * cannot read the app's cookies or storage, cannot touch the parent page, and
 * cannot make a credentialed request to the app. Its own files are fetched with
 * CORS (the `/emulator/ejs/*` files are public and carry
 * `Access-Control-Allow-Origin: *`), and a sandboxed page has no web storage at
 * all, which is what we want.
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

  /** The origin of the page that embedded us, or "" when it did not say. */
  var parentOrigin = (function () {
    try {
      var raw = new URLSearchParams(window.location.search).get("o") || "";
      return new URL(raw).origin === raw ? raw : "";
    } catch (e) {
      return "";
    }
  })();

  // A sandboxed page may not touch web storage: the getter throws, and the
  // emulator reads it before it checks its own "no storage" setting. Say
  // plainly that there is none.
  try {
    Object.defineProperty(window, "localStorage", { value: null, configurable: true });
  } catch (e) {
    /* nothing to hide, nothing to fix */
  }

  function tell(message) {
    if (parentOrigin) {
      window.parent.postMessage(message, parentOrigin);
    }
  }

  function boot(file, language) {
    if (started) {
      return;
    }
    var name = typeof file.name === "string" ? file.name : "";
    var dot = name.lastIndexOf(".");
    var extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    var core = CORE_BY_EXTENSION[extension];
    if (!core) {
      tell({ type: "pqp-emulator-error", reason: "unsupported" });
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
      tell({ type: "pqp-emulator-error", reason: "load" });
    };
    document.head.appendChild(script);
    tell({ type: "pqp-emulator-started" });
    watchStartup();
  }

  /**
   * Tells the page how startup went, from what the emulator draws: its own error
   * text means the core or the game failed to load (the page then shows its own
   * message), and its start button means core and game are both in and it is
   * waiting for the player. Reads the emulator's elements only, never the file.
   */
  function watchStartup() {
    var done = false;
    function check() {
      if (done) {
        return;
      }
      if (document.querySelector(".ejs_error_text")) {
        done = true;
        observer.disconnect();
        tell({ type: "pqp-emulator-error", reason: "load" });
      } else if (document.querySelector(".ejs_start_button")) {
        done = true;
        observer.disconnect();
        tell({ type: "pqp-emulator-initialized" });
      }
    }
    var observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    check();
  }

  window.addEventListener("message", function (event) {
    if (!parentOrigin || event.origin !== parentOrigin || event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== "pqp-emulator-load" || !(data.file instanceof File)) {
      return;
    }
    boot(data.file, typeof data.language === "string" ? data.language : "en-US");
  });

  // Tell the page that opened us we can take a file now.
  tell({ type: "pqp-emulator-ready" });
})();
