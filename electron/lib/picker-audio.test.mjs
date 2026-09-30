import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { defaultAudioChecked, audioRowView } = require("../picker/audio-state.js");

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const locale = (name) => JSON.parse(read(`../locales/${name}.json`));

const strings = {
  shareAudio: "Compartilhar o som do computador",
  shareAudioHint: "Quem assiste ouve o que está tocando, sem a call.",
  shareAudioOffNote: "Sem som: quem assiste só vê a tela.",
  shareAudioWin10: "Som do computador não disponível no Windows 10",
  shareAudioWin10Hint: "Pra mandar som: abra a pqp no Chrome.",
};

describe("the picker's sound row", () => {
  it("starts ON whenever the picker offers a real choice", () => {
    assert.equal(defaultAudioChecked("checkbox"), true);
    const view = audioRowView("checkbox", defaultAudioChecked("checkbox"), strings);
    assert.equal(view.visible, true);
    assert.equal(view.hasSwitch, true);
    assert.equal(view.checked, true);
    assert.equal(view.icon, "on");
    assert.equal(view.label, strings.shareAudio);
    assert.equal(view.hint, strings.shareAudioHint);
  });

  it("has no off-state note while it is on", () => {
    assert.equal(audioRowView("checkbox", true, strings).note, "");
  });

  it("says what the viewers get when it is turned off", () => {
    const view = audioRowView("checkbox", false, strings);
    assert.equal(view.checked, false);
    assert.equal(view.note, "Sem som: quem assiste só vê a tela.");
    assert.equal(view.icon, "off");
    // The helper stays: the row still says what the switch does.
    assert.equal(view.hint, strings.shareAudioHint);
  });

  it("honours an untick for that share only: the next picker starts on again", () => {
    // The page holds the choice; nothing is stored, so a fresh picker (a fresh
    // page) reads the default again.
    assert.equal(audioRowView("checkbox", false, strings).checked, false);
    assert.equal(defaultAudioChecked("checkbox"), true);
  });

  it("leaves the Windows 10 explanation as it was: the words, no switch, never ticked", () => {
    assert.equal(defaultAudioChecked("explain"), false);
    const view = audioRowView("explain", defaultAudioChecked("explain"), strings);
    assert.deepEqual(
      { visible: view.visible, hasSwitch: view.hasSwitch, checked: view.checked, note: view.note },
      { visible: true, hasSwitch: false, checked: false, note: "" },
    );
    assert.equal(view.label, strings.shareAudioWin10);
    assert.equal(view.hint, strings.shareAudioWin10Hint);
  });

  it("draws nothing where there is no sound to offer (macOS, Linux)", () => {
    assert.equal(defaultAudioChecked("hidden"), false);
    const view = audioRowView("hidden", false, strings);
    assert.equal(view.visible, false);
    assert.equal(view.hasSwitch, false);
    // An unknown state is the quiet one too.
    assert.equal(audioRowView("whatever", true, strings).visible, false);
  });
});

describe("a switch that starts on starts nothing", () => {
  const picker = read("../picker/picker.js");
  const main = read("../main.js");

  it("only `shareSelected` sends the choice out of the picker window, and only with a surface picked", () => {
    const calls = picker.match(/bridge\.choose\(/g) ?? [];
    assert.equal(calls.length, 1);
    const fn = picker.slice(picker.indexOf("function shareSelected()"));
    assert.ok(fn.indexOf("bridge.choose(") > 0 && fn.indexOf("bridge.choose(") < fn.indexOf("\n}\n"));
    assert.match(fn.slice(0, fn.indexOf("bridge.choose(")), /!selectedId/);
  });

  it("does not report the switch anywhere else (not on render, not on change)", () => {
    assert.doesNotMatch(picker, /pqp:picker-choose/);
    const change = picker.slice(picker.indexOf('el.shareAudio.addEventListener("change"'));
    assert.doesNotMatch(change.slice(0, change.indexOf("});")), /bridge\./);
  });

  it("main starts no capture before the picker has answered", () => {
    const body = main.slice(main.indexOf("async function chooseDisplaySource"));
    const picked = body.indexOf("await showSourcePicker(");
    const started = body.indexOf("shareAudio().start(");
    assert.ok(picked > 0 && started > picked, "the native capture starts after the picker resolves");
    // And only for a choice that says so.
    assert.match(body.slice(started - 120, started), /choice\.shareAudio === true/);
  });
});

describe("the picker's page", () => {
  const html = read("../picker/index.html");

  it("loads the row's logic before the picker script", () => {
    assert.ok(html.indexOf("audio-state.js") > 0);
    assert.ok(html.indexOf("audio-state.js") < html.indexOf("picker.js"));
  });

  it("names and describes the switch for a screen reader, and the whole row toggles it", () => {
    assert.match(html, /<label id="audio-row"/);
    assert.match(html, /role="switch"/);
    assert.match(html, /aria-labelledby="audio-label"/);
    assert.match(html, /aria-describedby="audio-hint audio-note"/);
    // The state note is announced when it appears.
    assert.match(html, /id="audio-note"[^>]*role="status"/);
  });

  it("gets its default from the code, not from a markup attribute that could drift", () => {
    assert.doesNotMatch(html, /id="share-audio"[^>]*\schecked/);
  });

  it("uses no colour literal of its own: the row takes the picker's variables", () => {
    const css = read("../picker/picker.css");
    const row = css.slice(css.indexOf(".audio-row {"), css.indexOf(".actions {"));
    assert.doesNotMatch(row, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(row, /\brgba?\(/);
  });
});

describe("the row's copy", () => {
  const keys = ["share.audio", "share.audioHint", "share.audioOffNote"];

  for (const name of ["en", "pt-BR", "es"]) {
    it(`exists in ${name}, in full sentences and with no em dash`, () => {
      const strings = locale(name);
      for (const key of keys) {
        assert.equal(typeof strings[key], "string", `${key} in ${name}`);
        assert.ok(strings[key].length > 10);
        assert.ok(!strings[key].includes("—"), `${key} in ${name} has an em dash`);
      }
    });
  }

  it("says the same thing in the QG's words in Portuguese", () => {
    const pt = locale("pt-BR");
    assert.equal(pt["share.audio"], "Compartilhar o som do computador");
    assert.equal(pt["share.audioHint"], "Quem assiste ouve o que está tocando, sem a call.");
    assert.equal(pt["share.audioOffNote"], "Sem som: quem assiste só vê a tela.");
  });

  it("no longer says Windows 11 only: the native capture offers it on any Windows", () => {
    for (const name of ["en", "pt-BR", "es"]) {
      assert.doesNotMatch(locale(name)["share.audioHint"], /Windows 11/);
    }
  });
});
