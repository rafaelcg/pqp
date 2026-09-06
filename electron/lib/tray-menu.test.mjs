import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  buildTrayTemplate,
  trayTooltip,
  shouldHideToTray,
  normalizeVoiceState,
} = require("./tray-menu.js");
const { trayIconKind, paintTrayIcon, encodePng } = require("./tray-icon.js");

const t = (key) => key;

function actionsLog() {
  const calls = [];
  return {
    calls,
    actions: {
      toggleMute: () => calls.push("toggleMute"),
      toggleDeafen: () => calls.push("toggleDeafen"),
      leave: () => calls.push("leave"),
      show: () => calls.push("show"),
      setKeepInTray: (v) => calls.push(`keep:${v}`),
      quit: () => calls.push("quit"),
    },
  };
}

const labels = (tpl) => tpl.map((i) => i.label ?? i.type);

describe("buildTrayTemplate", () => {
  it("greys the call items out of a call and keeps the order stable", () => {
    const idle = buildTrayTemplate(
      { inCall: false, muted: false, deafened: false },
      { keepInTray: true },
      t,
      actionsLog().actions,
    );
    const live = buildTrayTemplate(
      { inCall: true, muted: true, deafened: false },
      { keepInTray: false },
      t,
      actionsLog().actions,
    );
    assert.deepEqual(labels(idle), [
      "tray.idle",
      "separator",
      "tray.mute",
      "tray.deafen",
      "tray.leave",
      "separator",
      "tray.show",
      "tray.keepInTray",
      "separator",
      "tray.quit",
    ]);
    assert.deepEqual(
      labels(live).filter((l) => l !== "separator"),
      [
        "tray.inCall",
        "tray.unmute",
        "tray.deafen",
        "tray.leave",
        "tray.show",
        "tray.keepInTray",
        "tray.quit",
      ],
    );
    assert.equal(idle[2].enabled, false);
    assert.equal(idle[4].enabled, false);
    assert.equal(live[2].enabled, true);
    assert.equal(idle[7].checked, true);
    assert.equal(live[7].checked, false);
  });

  it("routes every click to the named action", () => {
    const { calls, actions } = actionsLog();
    const tpl = buildTrayTemplate(
      { inCall: true, muted: false, deafened: true },
      { keepInTray: false },
      t,
      actions,
    );
    assert.equal(tpl[3].label, "tray.undeafen");
    for (const item of tpl) {
      if (typeof item.click === "function") {
        item.click({ checked: true });
      }
    }
    assert.deepEqual(calls, [
      "toggleMute",
      "toggleDeafen",
      "leave",
      "show",
      "keep:true",
      "quit",
    ]);
  });
});

describe("trayTooltip and trayIconKind", () => {
  it("say the loudest fact: deafened beats muted beats live", () => {
    const s = (inCall, muted, deafened) => ({ inCall, muted, deafened });
    assert.equal(trayTooltip(s(false, false, false), t), "tray.tooltipIdle");
    assert.equal(trayTooltip(s(true, false, false), t), "tray.tooltipLive");
    assert.equal(trayTooltip(s(true, true, false), t), "tray.tooltipMuted");
    assert.equal(trayTooltip(s(true, true, true), t), "tray.tooltipDeafened");
    assert.equal(trayIconKind(s(false, true, true)), "idle");
    assert.equal(trayIconKind(s(true, false, false)), "live");
    assert.equal(trayIconKind(s(true, true, false)), "muted");
    assert.equal(trayIconKind(s(true, true, true)), "deafened");
  });
});

describe("shouldHideToTray", () => {
  it("hides only during a call with the preference on, never while quitting", () => {
    assert.equal(
      shouldHideToTray({ inCall: true, keepInTray: true, quitting: false }),
      true,
    );
    assert.equal(
      shouldHideToTray({ inCall: false, keepInTray: true, quitting: false }),
      false,
    );
    assert.equal(
      shouldHideToTray({ inCall: true, keepInTray: false, quitting: false }),
      false,
    );
    assert.equal(
      shouldHideToTray({ inCall: true, keepInTray: true, quitting: true }),
      false,
    );
  });
});

describe("normalizeVoiceState", () => {
  it("refuses garbage and never reports muted out of a call", () => {
    const idle = { inCall: false, muted: false, deafened: false };
    assert.deepEqual(normalizeVoiceState(null), idle);
    assert.deepEqual(normalizeVoiceState({ inCall: "yes", muted: true }), idle);
    assert.deepEqual(
      normalizeVoiceState({ inCall: true, muted: true, deafened: 1 }),
      { inCall: true, muted: true, deafened: false },
    );
  });
});

describe("tray icon painting", () => {
  it("paints every state at both scales into a well-formed PNG", () => {
    for (const kind of ["idle", "live", "muted", "deafened"]) {
      for (const template of [true, false]) {
        for (const scale of [1, 2]) {
          const painted = paintTrayIcon(kind, { template, scale });
          assert.equal(painted.width, 16 * scale);
          assert.equal(
            painted.rgba.length,
            painted.width * painted.height * 4,
          );
          const png = encodePng(painted);
          assert.deepEqual(
            [...png.subarray(0, 8)],
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          );
          assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
          assert.equal(png.readUInt32BE(16), 16 * scale);
          assert.equal(
            png.subarray(png.length - 8, png.length - 4).toString("ascii"),
            "IEND",
          );
        }
      }
    }
  });

  it("template icons are black with alpha; colour icons put red on the slash", () => {
    const tpl = paintTrayIcon("muted", { template: true, scale: 1 });
    for (let i = 0; i < tpl.rgba.length; i += 4) {
      assert.equal(tpl.rgba[i], 0);
    }
    const colour = paintTrayIcon("muted", { template: false, scale: 1 });
    let red = 0;
    for (let i = 0; i < colour.rgba.length; i += 4) {
      if (colour.rgba[i] === 239 && colour.rgba[i + 3] === 255) {
        red += 1;
      }
    }
    assert.ok(red > 8);
  });
});
