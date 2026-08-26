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

  it("calls macOS denied and restricted blocked", () => {
    assert.equal(screenPermission("darwin", "denied"), "blocked");
    assert.equal(screenPermission("darwin", "restricted"), "blocked");
  });

  it("does not call not-determined blocked", () => {
    // Refusing here means the macOS prompt is never shown, so permission can
    // never be granted and the app is permanently stuck saying "go turn it on"
    // about a switch that does not exist yet.
    assert.equal(screenPermission("darwin", "not-determined"), "undetermined");
  });

  it("treats granted and unknown as fine", () => {
    assert.equal(screenPermission("darwin", "granted"), "ok");
    // Older macOS reports "unknown" for a capability it does not gate.
    assert.equal(screenPermission("darwin", "unknown"), "ok");
    assert.equal(screenPermission("darwin", undefined), "ok");
  });
});

describe("captureResponse", () => {
  const source = { id: "screen:0:0", name: "Screen 1" };

  it("asks for loopback audio only on Windows", () => {
    assert.deepEqual(captureResponse(source, "win32", true), {
      video: source,
      audio: "loopback",
    });
  });

  it("never asks for loopback elsewhere", () => {
    // Not a silent share: on macOS this fails the whole request, so the user
    // gets nothing rather than a video-only share.
    for (const platform of ["darwin", "linux"]) {
      assert.deepEqual(captureResponse(source, platform, true), { video: source });
    }
  });

  it("skips audio the page never asked for", () => {
    assert.deepEqual(captureResponse(source, "win32", false), { video: source });
  });

  it("returns null when there is no source", () => {
    assert.equal(captureResponse(null, "win32", true), null);
    assert.equal(captureResponse(undefined, "darwin", false), null);
  });
});
