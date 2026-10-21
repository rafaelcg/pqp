/*
 * The page between the app and the emulator's sandboxed frame. See room.html for
 * why it exists (the `frame-src` that stops the emulator's frame navigating
 * itself away with the game's bytes in an address).
 *
 * It is first-party code and does three things: hands the picked `File` from
 * the app to a freshly created sandboxed frame, relays the frame's startup
 * messages back up, and removes the frame if it ever loads a second time (a
 * frame that navigated is hostile). It never reads, keeps, sends or logs the
 * file or its name, and has no network of its own (room.html's policy).
 */
(function () {
  "use strict";

  /** The only document the emulator's frame is ever given. */
  var FRAME_SRC = "/emulator/frame.html";

  /** The app embeds this page from its own origin. */
  var appOrigin = window.location.origin;

  /** What a message from a sandboxed (opaque-origin) frame reports as its origin. */
  var FRAME_ORIGIN = "null";

  /** Startup messages from the frame that the app gets to see. */
  var RELAYED = {
    "pqp-emulator-started": true,
    "pqp-emulator-initialized": true,
    "pqp-emulator-error": true,
  };

  var frame = null;
  var frameLoads = 0;
  var pending = null;
  var readyTimer = 0;

  function up(message) {
    window.parent.postMessage(message, appOrigin);
  }

  function removeFrame() {
    if (frame) {
      frame.remove();
      frame = null;
    }
    pending = null;
  }

  function openFrame(file, language) {
    pending = { file: file, language: language };
    var element = document.createElement("iframe");
    // Scripts only, NO `allow-same-origin`: the emulator and any game file that
    // attacks it run in an opaque origin, with no access to the app, its cookies
    // or storage, or its API as the signed-in person.
    element.setAttribute("sandbox", "allow-scripts");
    element.setAttribute("allow", "autoplay; fullscreen; gamepad");
    element.setAttribute("referrerpolicy", "no-referrer");
    element.setAttribute("title", "Emulator");
    element.addEventListener("load", function () {
      frameLoads += 1;
      if (frameLoads > 1) {
        // A frame that loads twice navigated itself: take it down, tell the app.
        removeFrame();
        up({ type: "pqp-emulator-error", reason: "navigated" });
      }
    });
    element.src = FRAME_SRC + "?o=" + encodeURIComponent(appOrigin);
    frame = element;
    document.getElementById("stage").appendChild(element);
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data.type !== "string") {
      return;
    }

    if (event.source === window.parent) {
      if (event.origin !== appOrigin) {
        return;
      }
      if (data.type === "pqp-emulator-load" && data.file instanceof File && !frame) {
        window.clearInterval(readyTimer);
        openFrame(data.file, typeof data.language === "string" ? data.language : "en-US");
      }
      return;
    }

    if (!frame || event.source !== frame.contentWindow || event.origin !== FRAME_ORIGIN) {
      return;
    }
    if (data.type === "pqp-emulator-ready" && pending) {
      // The frame's own handshake: now it can take the file.
      frame.contentWindow.postMessage(
        { type: "pqp-emulator-load", file: pending.file, language: pending.language },
        "*",
      );
      pending = null;
    } else if (RELAYED[data.type]) {
      up({ type: data.type, reason: typeof data.reason === "string" ? data.reason : undefined });
    }
  });

  // Say we can take a file, and keep saying it until one arrives, so the app
  // cannot miss it however the two pages' loads interleave.
  up({ type: "pqp-emulator-ready" });
  readyTimer = window.setInterval(function () {
    up({ type: "pqp-emulator-ready" });
  }, 250);
})();
