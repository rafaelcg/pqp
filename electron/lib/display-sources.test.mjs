import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  kindOf,
  toDataUrl,
  normalizeSources,
  labelSources,
  pickAutomatically,
  screenPermission,
  captureResponse,
  windowsNtBuild,
  windowsBuildAllowsOwnAudioExclude,
  pickerAudioState,
  parseMacVersion,
  macVersionAllowsSystemAudio,
  MAC_AUDIO_SETTINGS_URL,
} = require("./display-sources.js");

/** A `NativeImage` as far as this module is concerned. */
function image(dataUrl) {
  return { toDataURL: () => dataUrl };
}

/** 320x200 of nothing, long enough to read as a real picture. */
const REAL_THUMBNAIL = `data:image/png;base64,${"A".repeat(200)}`;

describe("kindOf", () => {
  it("reads the kind off the id, not the name", () => {
    // The whole reason this is id-based: a window may be called "Screen", and
    // on a Portuguese macOS a display is called "Tela".
    assert.equal(kindOf("screen:0:0"), "screen");
    assert.equal(kindOf("window:98765:0"), "window");
  });

  it("rejects anything it does not recognise", () => {
    for (const id of ["", "tab:1", "screen", null, undefined, 7]) {
      assert.equal(kindOf(id), null);
    }
  });
});

describe("toDataUrl", () => {
  it("passes a real thumbnail through", () => {
    assert.equal(toDataUrl(image(REAL_THUMBNAIL)), REAL_THUMBNAIL);
  });

  it("returns null for a missing image", () => {
    assert.equal(toDataUrl(null), null);
    assert.equal(toDataUrl(undefined), null);
    assert.equal(toDataUrl({}), null);
  });

  it("returns null for Electron's blank image rather than a broken img", () => {
    // An empty NativeImage serializes to a short, valid data URL. Handing that
    // to the picker draws a broken image where a label should be.
    assert.equal(toDataUrl(image("data:image/png;base64,")), null);
  });

  it("returns null when toDataURL throws", () => {
    assert.equal(
      toDataUrl({
        toDataURL() {
          throw new Error("no display");
        },
      }),
      null,
    );
  });

  it("refuses a non-image string", () => {
    // Defensive: this string ends up in an `<img src>` in the picker window.
    assert.equal(toDataUrl(image("javascript:alert(1)")), null);
    assert.equal(toDataUrl(image(`data:text/html,${"x".repeat(200)}`)), null);
  });
});

describe("normalizeSources", () => {
  it("offers windows, which is the entire bug", () => {
    // Before this, `getSources({ types: ["screen"] })` meant a window could
    // never be shared from the desktop app at all.
    const out = normalizeSources([
      { id: "window:1:0", name: "Firefox", thumbnail: image(REAL_THUMBNAIL) },
      { id: "screen:0:0", name: "Screen 1", thumbnail: image(REAL_THUMBNAIL) },
    ]);
    assert.deepEqual(
      out.map((s) => s.kind),
      ["screen", "window"],
    );
  });

  it("keeps every screen, so the second monitor is reachable", () => {
    const out = normalizeSources([
      { id: "screen:0:0", name: "Screen 1" },
      { id: "screen:1:0", name: "Screen 2" },
    ]);
    assert.deepEqual(
      out.map((s) => s.id),
      ["screen:0:0", "screen:1:0"],
    );
  });

  it("keeps OS order within a group so the primary display stays first", () => {
    const out = normalizeSources([
      { id: "window:2:0", name: "Terminal" },
      { id: "screen:0:0", name: "Primary" },
      { id: "window:1:0", name: "Firefox" },
      { id: "screen:1:0", name: "Secondary" },
    ]);
    assert.deepEqual(
      out.map((s) => s.name),
      ["Primary", "Secondary", "Terminal", "Firefox"],
    );
  });

  it("carries thumbnails, which is how three windows named alike are told apart", () => {
    const out = normalizeSources([
      { id: "window:1:0", name: "Untitled", thumbnail: image(REAL_THUMBNAIL) },
    ]);
    assert.equal(out[0].thumbnail, REAL_THUMBNAIL);
  });

  it("carries an app icon for windows and never for screens", () => {
    const out = normalizeSources([
      { id: "screen:0:0", name: "Screen 1", appIcon: image(REAL_THUMBNAIL) },
      { id: "window:1:0", name: "Firefox", appIcon: image(REAL_THUMBNAIL) },
    ]);
    assert.equal(out[0].appIcon, null);
    assert.equal(out[1].appIcon, REAL_THUMBNAIL);
  });

  it("passes an empty name through for the picker to label", () => {
    // Naming it here would be an untranslatable English string.
    const out = normalizeSources([{ id: "window:1:0", name: "" }]);
    assert.equal(out[0].name, "");
  });

  it("drops sources it cannot classify", () => {
    const out = normalizeSources([
      { id: "screen:0:0", name: "Screen 1" },
      { id: "tab:1:0", name: "A tab" },
      { name: "no id" },
      null,
    ]);
    assert.equal(out.length, 1);
  });

  it("survives being handed nothing", () => {
    assert.deepEqual(normalizeSources(undefined), []);
    assert.deepEqual(normalizeSources(null), []);
    assert.deepEqual(normalizeSources([]), []);
  });

  it("produces only IPC-safe plain data", () => {
    const out = normalizeSources([
      { id: "screen:0:0", name: "Screen 1", thumbnail: image(REAL_THUMBNAIL) },
    ]);
    // A NativeImage cannot be structured-cloned; a leak here throws when the
    // picker asks for its data and the share dies with no picker at all.
    assert.doesNotThrow(() => structuredClone(out));
  });
});

describe("labelSources", () => {
  /** Stands in for `lib/i18n.js`, single-brace interpolation and all. */
  const translate = (key, vars) =>
    ({
      "share.screenFallback": `Screen ${vars?.index}`,
      "share.windowFallback": "Untitled window",
    })[key] ?? key;

  it("uses the name the OS gave", () => {
    const out = labelSources(
      normalizeSources([{ id: "window:1:0", name: "Firefox" }]),
      translate,
    );
    assert.equal(out[0].label, "Firefox");
  });

  it("numbers unnamed screens within the screen group", () => {
    // "Screen 2" has to be the second display. If windows were counted too,
    // the number on the tile would mean nothing on screen.
    const out = labelSources(
      normalizeSources([
        { id: "window:1:0", name: "" },
        { id: "screen:0:0", name: "" },
        { id: "screen:1:0", name: "" },
      ]),
      translate,
    );
    assert.deepEqual(
      out.map((s) => s.label),
      ["Screen 1", "Screen 2", "Untitled window"],
    );
  });

  it("keeps numbering right when only some screens are unnamed", () => {
    const out = labelSources(
      normalizeSources([
        { id: "screen:0:0", name: "Built-in Retina Display" },
        { id: "screen:1:0", name: "" },
      ]),
      translate,
    );
    assert.deepEqual(
      out.map((s) => s.label),
      ["Built-in Retina Display", "Screen 2"],
    );
  });

  it("does not accept whitespace as a name", () => {
    const out = labelSources(
      normalizeSources([{ id: "window:1:0", name: "   " }]),
      translate,
    );
    assert.equal(out[0].label, "Untitled window");
  });

  it("leaves the rest of the entry alone", () => {
    const out = labelSources(
      normalizeSources([
        { id: "screen:0:0", name: "Screen 1", thumbnail: image(REAL_THUMBNAIL) },
      ]),
      translate,
    );
    assert.equal(out[0].id, "screen:0:0");
    assert.equal(out[0].kind, "screen");
    assert.equal(out[0].thumbnail, REAL_THUMBNAIL);
  });

  it("survives an empty list", () => {
    assert.deepEqual(labelSources([], translate), []);
    assert.deepEqual(labelSources(undefined, translate), []);
  });
});

describe("pickAutomatically", () => {
  it("skips the dialog when there is exactly one surface", () => {
    // Wayland portals and the permission-less macOS state both land here. A
    // picker offering one option is a click with only one possible answer.
    assert.equal(pickAutomatically([{ id: "screen:0:0" }]), "screen:0:0");
  });

  it("shows the picker as soon as there is a real choice", () => {
    assert.equal(
      pickAutomatically([{ id: "screen:0:0" }, { id: "window:1:0" }]),
      null,
    );
  });

  it("has nothing to pick from an empty list", () => {
    assert.equal(pickAutomatically([]), null);
    assert.equal(pickAutomatically(undefined), null);
  });
});

describe("screenPermission", () => {
  it("never gates a platform that has no such gate", () => {
    for (const platform of ["win32", "linux"]) {
      for (const status of ["denied", "restricted", "not-determined", "unknown"]) {
        assert.equal(screenPermission(platform, status), "ok");
      }
    }
  });

  it("calls only macOS restricted blocked before listing", () => {
    assert.equal(screenPermission("darwin", "restricted"), "blocked");
  });

  it("does not call denied or not-determined blocked", () => {
    // Electron's screen preflight on macOS is a yes/no: a Mac that was never
    // asked reports "denied". Refusing here means the macOS prompt is never
    // shown, the app never appears under Privacy & Security, and the user is
    // permanently told to "go turn it on" about a switch that does not exist.
    // The caller lists first (which is what raises the prompt) and re-reads.
    assert.equal(screenPermission("darwin", "denied"), "undetermined");
    assert.equal(screenPermission("darwin", "not-determined"), "undetermined");
  });

  it("treats granted and unknown as fine", () => {
    assert.equal(screenPermission("darwin", "granted"), "ok");
    // Older macOS reports "unknown" for a capability it does not gate.
    assert.equal(screenPermission("darwin", "unknown"), "ok");
    assert.equal(screenPermission("darwin", undefined), "ok");
  });
});

describe("windowsNtBuild", () => {
  it("reads the third component, never major === 11", () => {
    assert.equal(windowsNtBuild("10.0.22631"), 22631);
    assert.equal(windowsNtBuild("10.0.22000"), 22000);
    assert.equal(windowsNtBuild("10.0.19045"), 19045);
    assert.equal(windowsNtBuild("11.0.0"), 0);
  });

  it("refuses Server 2022 and Windows 10", () => {
    assert.equal(windowsBuildAllowsOwnAudioExclude("10.0.20348"), false);
    assert.equal(windowsBuildAllowsOwnAudioExclude("10.0.19045"), false);
    assert.equal(windowsBuildAllowsOwnAudioExclude("10.0.22000"), true);
    assert.equal(windowsBuildAllowsOwnAudioExclude("10.0.22631"), true);
    assert.equal(windowsBuildAllowsOwnAudioExclude(""), false);
    assert.equal(windowsBuildAllowsOwnAudioExclude(undefined), false);
  });
});

describe("pickerAudioState", () => {
  it("hides the row on Linux, and on a Mac whose version could not be read", () => {
    assert.equal(pickerAudioState("darwin", "10.0.22631"), "hidden");
    assert.equal(pickerAudioState("darwin", "23.2.0", { version: "" }), "hidden");
    assert.equal(pickerAudioState("darwin", "23.2.0", { version: undefined }), "hidden");
    assert.equal(pickerAudioState("linux", "10.0.22631"), "hidden");
  });

  it("offers a real checkbox on Windows 11", () => {
    assert.equal(pickerAudioState("win32", "10.0.22000"), "checkbox");
    assert.equal(pickerAudioState("win32", "10.0.22631"), "checkbox");
  });

  it("explains instead of offering a checkbox that would lie on Windows 10", () => {
    // The live case this exists for: cap1tao, 27 Sep 2026, Windows desktop
    // app, a picker with no sound row at all.
    assert.equal(pickerAudioState("win32", "10.0.19045"), "explain");
    assert.equal(pickerAudioState("win32", "10.0.20348"), "explain");
    assert.equal(pickerAudioState("win32", ""), "explain");
    assert.equal(pickerAudioState("win32", undefined), "explain");
  });
});

describe("captureResponse", () => {
  const source = { id: "screen:0:0", name: "Screen 1" };
  const win11 = "10.0.22631";

  it("asks for loopback audio only on Windows 11", () => {
    assert.deepEqual(captureResponse(source, "win32", true, win11), {
      video: source,
      audio: "loopback",
    });
  });

  it("refuses loopback on Windows 10 and Server 2022", () => {
    for (const release of ["10.0.19045", "10.0.20348", undefined, ""]) {
      assert.deepEqual(captureResponse(source, "win32", true, release), {
        video: source,
      });
    }
  });

  it("never asks for loopback elsewhere", () => {
    // Not a silent share: on macOS this fails the whole request, so the user
    // gets nothing rather than a video-only share.
    for (const platform of ["darwin", "linux"]) {
      assert.deepEqual(captureResponse(source, platform, true, win11), {
        video: source,
      });
    }
  });

  it("skips audio the page never asked for", () => {
    assert.deepEqual(captureResponse(source, "win32", false, win11), {
      video: source,
    });
  });

  it("is the echo switch: no request, no whole-system loopback", () => {
    // The 23 Aug 2026 report. `"loopback"` is what we hand the embedder; from
    // Electron 43.4 the embedder remaps it to `loopbackWithoutChrome` when the
    // page asked `restrictOwnAudio`. A false `audioRequested` must still skip
    // the tap entirely, including on v0.1.3, and for every source kind.
    for (const candidate of [source, { id: "window:12:0", name: "Game" }]) {
      const response = captureResponse(candidate, "win32", false, win11);
      assert.equal(response.audio, undefined);
      assert.equal(response.video, candidate);
    }
  });

  it("returns null when there is no source", () => {
    assert.equal(captureResponse(null, "win32", true, win11), null);
    assert.equal(captureResponse(undefined, "darwin", false), null);
  });
});

describe("macOS system audio", () => {
  const source = { id: "screen:1:0", name: "Screen 1" };

  it("reads the macOS version, never the Darwin kernel number", () => {
    assert.deepEqual(parseMacVersion("14.2.1"), { major: 14, minor: 2 });
    assert.deepEqual(parseMacVersion("15"), { major: 15, minor: 0 });
    assert.deepEqual(parseMacVersion("26.0"), { major: 26, minor: 0 });
    for (const bad of ["", "x.y", null, undefined, 14]) {
      assert.equal(parseMacVersion(bad), null);
    }
  });

  it("opens the CoreAudio Tap gate at 14.2 exactly", () => {
    for (const ok of ["14.2", "14.2.1", "14.7", "15.0", "26.0", "27.0.1"]) {
      assert.equal(macVersionAllowsSystemAudio(ok), true, ok);
    }
    // 14.1 and earlier have no tap: Chromium returns no stream and the whole
    // capture fails if asked, so these must never get loopback.
    for (const no of ["13.6.9", "14.0", "14.1", "14.1.2", "12.7.6", "10.15", "", undefined, "garbage"]) {
      assert.equal(macVersionAllowsSystemAudio(no), false, String(no));
    }
  });

  it("answers loopback only for a wanted request on a Mac that has the tap", () => {
    assert.deepEqual(captureResponse(source, "darwin", true, "", "14.2"), {
      video: source,
      audio: "loopback",
    });
    assert.deepEqual(captureResponse(source, "darwin", true, "", "15.1"), {
      video: source,
      audio: "loopback",
    });
  });

  it("stays video-only everywhere else on a Mac, so a capture can never be rejected", () => {
    // Not wanted.
    assert.deepEqual(captureResponse(source, "darwin", false, "", "15.1"), { video: source });
    // Too old: loopback would fail the whole capture.
    assert.deepEqual(captureResponse(source, "darwin", true, "", "13.6"), { video: source });
    assert.deepEqual(captureResponse(source, "darwin", true, "", "14.1"), { video: source });
    // A caller that never passes the version (every call site before this).
    assert.deepEqual(captureResponse(source, "darwin", true, ""), { video: source });
    assert.deepEqual(captureResponse(source, "darwin", true), { video: source });
  });

  it("never lets a macOS version turn Linux or Windows 10 into loopback", () => {
    assert.deepEqual(captureResponse(source, "linux", true, "", "15.1"), { video: source });
    assert.deepEqual(captureResponse(source, "win32", true, "10.0.19045", "15.1"), {
      video: source,
    });
  });

  it("gives the picker a Mac row of its own, in three states", () => {
    assert.equal(pickerAudioState("darwin", "", { version: "15.1", armed: true }), "checkbox");
    assert.equal(pickerAudioState("darwin", "", { version: "14.2", armed: true }), "checkbox");
    // Nobody armed: the flag is off or the page is older than the shell.
    assert.equal(pickerAudioState("darwin", "", { version: "15.1", armed: false }), "explain-mac");
    assert.equal(pickerAudioState("darwin", "", { version: "15.1" }), "explain-mac");
    // Too old, armed or not: no API at all.
    assert.equal(pickerAudioState("darwin", "", { version: "13.6", armed: true }), "explain-mac-old");
    assert.equal(pickerAudioState("darwin", "", { version: "14.1", armed: false }), "explain-mac-old");
  });

  it("does not change the Windows rows", () => {
    assert.equal(pickerAudioState("win32", "10.0.22631", { version: "15.1", armed: true }), "checkbox");
    assert.equal(pickerAudioState("win32", "10.0.19045", { version: "15.1", armed: true }), "explain");
  });

  it("points at the System Audio Recording pane, not Screen Recording", () => {
    assert.match(MAC_AUDIO_SETTINGS_URL, /^x-apple\.systempreferences:/);
    assert.match(MAC_AUDIO_SETTINGS_URL, /Privacy_AudioCapture$/);
  });
});
