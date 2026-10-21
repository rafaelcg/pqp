import { describe, expect, it } from "vitest";
import { createGamepadWatcher, heldButtons, padName, type PadLike } from "./gamepad";
import {
  BUTTONS_BY_PLATFORM,
  createRemapSession,
  defaultKeymap,
  defaultKeymaps,
  dpadIsArrows,
  isReserved,
  keyLabel,
  parseKeymap,
  parseKeymaps,
  PLATFORMS,
  proposeRemap,
  RESERVED_CODES,
} from "./keymap";

describe("default maps", () => {
  it("bind every button of every console, to distinct keys, none of them a Locadora shortcut", () => {
    for (const platform of PLATFORMS) {
      const map = defaultKeymap(platform);
      expect(Object.keys(map).sort(), platform).toEqual([...BUTTONS_BY_PLATFORM[platform]].sort());
      const codes = Object.values(map);
      expect(new Set(codes).size, platform).toBe(codes.length);
      for (const code of codes) expect(isReserved(code), `${platform} ${code}`).toBe(false);
      expect(dpadIsArrows(map)).toBe(true);
    }
  });

  it("keeps today's keys: Z is A, X is B, Enter is Start, V is Select, Q and E are the shoulders", () => {
    expect(defaultKeymap("gba")).toMatchObject({ a: "KeyZ", b: "KeyX", start: "Enter", select: "KeyV", l: "KeyQ", r: "KeyE" });
    expect(defaultKeymap("snes")).toMatchObject({ x: "KeyS", y: "KeyA" });
    expect(defaultKeymap("nes").l).toBeUndefined();
  });
});

describe("reserved keys (SPEC 8)", () => {
  it("are exactly Space, P, M, F, T, F1 to F4, F6, F8, Esc and Tab", () => {
    expect([...RESERVED_CODES].sort()).toEqual(
      ["Space", "KeyP", "KeyM", "KeyF", "KeyT", "F1", "F2", "F3", "F4", "F6", "F8", "Escape", "Tab"].sort(),
    );
  });

  it("are refused for any button on any console, and the map is left alone", () => {
    for (const platform of PLATFORMS) {
      const map = defaultKeymap(platform);
      for (const code of RESERVED_CODES) {
        for (const button of BUTTONS_BY_PLATFORM[platform]) {
          expect(proposeRemap(map, platform, button, code).status, `${platform} ${button} ${code}`).toBe("reserved");
        }
      }
      expect(map).toEqual(defaultKeymap(platform));
    }
  });

  it("do not stop other keys from being used", () => {
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "KeyC").status).toBe("free");
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "F7").status).toBe("free");
  });

  it("ignore a bare modifier without saying anything", () => {
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "ShiftLeft").status).toBe("ignored");
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "ControlRight").status).toBe("ignored");
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "CapsLock").status).toBe("ignored");
  });
});

describe("proposeRemap", () => {
  it("takes a free key", () => {
    const map = defaultKeymap("nes");
    expect(proposeRemap(map, "nes", "a", "KeyC")).toEqual({ status: "free", map: { ...map, a: "KeyC" } });
  });

  it("says same when the button already has the key", () => {
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "KeyZ").status).toBe("same");
  });

  it("detects a duplicate and offers a swap that gives the other button this one's old key", () => {
    const map = defaultKeymap("nes");
    const proposal = proposeRemap(map, "nes", "a", "KeyX");
    expect(proposal.status).toBe("duplicate");
    if (proposal.status !== "duplicate") return;
    expect(proposal.other).toBe("b");
    expect(proposal.swap.a).toBe("KeyX");
    expect(proposal.swap.b).toBe("KeyZ");
    expect(new Set(Object.values(proposal.swap)).size).toBe(Object.keys(proposal.swap).length);
    // nothing was applied
    expect(map).toEqual(defaultKeymap("nes"));
  });

  it("only sees duplicates among the console's own buttons", () => {
    // KeyA is Y on the SNES and free on the NES
    expect(proposeRemap(defaultKeymap("nes"), "nes", "a", "KeyA").status).toBe("free");
    expect(proposeRemap(defaultKeymap("snes"), "snes", "a", "KeyA").status).toBe("duplicate");
  });
});

describe("the listening session", () => {
  function session() {
    const maps: Array<[string, Record<string, string>]> = [];
    const s = createRemapSession({ platform: "nes", onMap: (p, m) => maps.push([p, { ...m }]) });
    return { s, maps };
  }

  it("binds one button on a key press and stops listening", () => {
    const { s, maps } = session();
    s.begin(["a"]);
    expect(s.state.queue).toEqual(["a"]);
    expect(s.press("KeyC")).toBe("bound");
    expect(s.state.maps.nes.a).toBe("KeyC");
    expect(s.state.queue).toEqual([]);
    expect(maps).toEqual([["nes", { ...defaultKeymap("nes"), a: "KeyC" }]]);
  });

  it("walks the four directions of the d-pad in order", () => {
    const { s } = session();
    s.begin(["up", "down", "left", "right"]);
    for (const code of ["KeyW", "KeyS", "KeyA", "KeyD"]) expect(s.press(code)).toBe("bound");
    expect(s.state.maps.nes).toMatchObject({ up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" });
    expect(dpadIsArrows(s.state.maps.nes)).toBe(false);
    expect(s.state.queue).toEqual([]);
  });

  it("refuses a reserved key, says why, and keeps listening for the same button", () => {
    const { s, maps } = session();
    s.begin(["a"]);
    expect(s.press("Space")).toBe("reserved");
    expect(s.state.note).toEqual({ kind: "reserved", code: "Space" });
    expect(s.state.queue).toEqual(["a"]);
    expect(s.state.maps.nes.a).toBe("KeyZ");
    expect(maps).toEqual([]);
    // the next good key clears the note
    expect(s.press("KeyC")).toBe("bound");
    expect(s.state.note).toBeNull();
  });

  it("refuses every reserved key the same way", () => {
    const { s } = session();
    s.begin(["a"]);
    for (const code of RESERVED_CODES) expect(s.press(code), code).toBe("reserved");
    expect(s.state.maps.nes).toEqual(defaultKeymap("nes"));
  });

  it("asks before taking a key from another button, and swaps on yes", () => {
    const { s } = session();
    s.begin(["a"]);
    expect(s.press("KeyX")).toBe("asks");
    expect(s.state.note).toMatchObject({ kind: "duplicate", code: "KeyX", other: "b" });
    // nothing moved yet, and further keys wait for the answer
    expect(s.state.maps.nes.a).toBe("KeyZ");
    expect(s.press("KeyC")).toBe("ignored");
    s.confirmSwap();
    expect(s.state.maps.nes).toMatchObject({ a: "KeyX", b: "KeyZ" });
    expect(s.state.queue).toEqual([]);
    expect(s.state.pending).toBeNull();
  });

  it("goes back to listening for the same button when the swap is declined", () => {
    const { s } = session();
    s.begin(["a"]);
    s.press("KeyX");
    s.declineSwap();
    expect(s.state.queue).toEqual(["a"]);
    expect(s.state.pending).toBeNull();
    expect(s.state.maps.nes).toEqual(defaultKeymap("nes"));
    expect(s.press("KeyC")).toBe("bound");
  });

  it("Esc cancels: what was bound stays, the rest is dropped", () => {
    const { s } = session();
    s.begin(["up", "down"]);
    s.press("KeyW");
    s.cancel();
    expect(s.state.queue).toEqual([]);
    expect(s.state.maps.nes).toMatchObject({ up: "KeyW", down: "ArrowDown" });
    expect(s.press("KeyS")).toBe("ignored");
  });

  it("resets only the console being shown", () => {
    const { s, maps } = session();
    s.begin(["a"]);
    s.press("KeyC");
    s.setPlatform("snes");
    s.begin(["a"]);
    s.press("KeyG");
    s.reset();
    expect(s.state.maps.snes).toEqual(defaultKeymap("snes"));
    expect(s.state.maps.nes.a).toBe("KeyC");
    expect(maps.at(-1)?.[0]).toBe("snes");
  });

  it("drops a listening session when the console tab changes", () => {
    const { s } = session();
    s.begin(["a"]);
    s.setPlatform("gba");
    expect(s.state.queue).toEqual([]);
    expect(s.state.platform).toBe("gba");
  });

  it("does not listen for a button the console does not have", () => {
    const { s } = session();
    s.begin(["x"]);
    expect(s.state.queue).toEqual([]);
  });
});

describe("stored maps", () => {
  it("come back as they went in", () => {
    const maps = defaultKeymaps();
    maps.nes = { ...maps.nes, a: "KeyC" };
    expect(parseKeymaps(JSON.parse(JSON.stringify(maps))).nes.a).toBe("KeyC");
  });

  it("fall back to the defaults on anything off: junk, a reserved or repeated key, a missing or unknown button", () => {
    const good = defaultKeymap("nes");
    const bad = [null, 3, "x", [], {}, { ...good, a: "Space" }, { ...good, a: "KeyX" }, { ...good, a: "" }, { ...good, nope: "KeyC" }, { ...good, a: 7 }, { ...good, a: "ShiftLeft" }];
    for (const value of bad) expect(parseKeymap(value, "nes"), JSON.stringify(value)).toEqual(good);
    expect(parseKeymaps(undefined)).toEqual(defaultKeymaps());
  });
});

describe("key labels", () => {
  it("write what is on the keycap", () => {
    expect(keyLabel("KeyZ")).toBe("Z");
    expect(keyLabel("Digit4")).toBe("4");
    expect(keyLabel("ArrowUp")).toBe("↑");
    expect(keyLabel("Enter")).toBe("Enter");
    expect(keyLabel("Numpad3")).toBe("Num 3");
    expect(keyLabel("F7")).toBe("F7");
  });
});

/* ---- the gamepad ---- */

const XBOX = "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)";

function pad(pressed: number[] = [], axes: number[] = [0, 0], connected = true): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) }));
  return { id: XBOX, connected, buttons, axes };
}

describe("gamepad buttons", () => {
  it("read the standard layout as the console's buttons", () => {
    expect([...heldButtons(pad([0, 9]), "gba")].sort()).toEqual(["b", "start"]);
    expect([...heldButtons(pad([12, 4]), "snes")].sort()).toEqual(["l", "up"]);
  });

  it("fold X and Y onto A and B where the console has neither, and drop shoulders it lacks", () => {
    expect([...heldButtons(pad([2, 3]), "nes")].sort()).toEqual(["a", "b"]);
    expect([...heldButtons(pad([2, 3]), "snes")].sort()).toEqual(["x", "y"]);
    expect([...heldButtons(pad([4, 5]), "nes")]).toEqual([]);
  });

  it("read a stick past half as the d-pad", () => {
    expect([...heldButtons(pad([], [-0.8, 0.9]), "nes")].sort()).toEqual(["down", "left"]);
    expect([...heldButtons(pad([], [0.3, -0.4]), "nes")]).toEqual([]);
  });

  it("name a pad without the vendor tail", () => {
    expect(padName(XBOX)).toBe("Xbox 360 Controller");
    expect(padName("Plain Pad")).toBe("Plain Pad");
  });
});

describe("the gamepad watcher", () => {
  function rig() {
    let pads: Array<PadLike | null> = [];
    const queue: Array<() => void> = [];
    const events: string[] = [];
    const watcher = createGamepadWatcher({
      platform: () => "nes",
      getPads: () => pads,
      schedule: (tick) => queue.push(tick),
      cancel: () => queue.splice(0),
      onFound: (name) => events.push(`found:${name}`),
      onLost: () => events.push("lost"),
      onHeld: (held) => events.push(`held:${[...held].sort().join("+")}`),
    });
    return {
      watcher,
      events,
      set: (next: Array<PadLike | null>) => {
        pads = next;
      },
      tick: () => queue.shift()?.(),
      pending: () => queue.length,
    };
  }

  it("says nothing while no pad is connected, reports the first one once, and what it holds", () => {
    const r = rig();
    r.watcher.start();
    expect(r.events).toEqual([]);
    r.set([null, pad([1])]);
    r.tick();
    expect(r.events).toEqual(["found:Xbox 360 Controller", "held:a"]);
    r.tick();
    expect(r.events).toHaveLength(2);
    r.set([null, pad([])]);
    r.tick();
    expect(r.events.at(-1)).toBe("held:");
    expect(r.watcher.found).toBe(true);
  });

  it("reports the pad lost, and stops polling when stopped", () => {
    const r = rig();
    r.set([pad([])]);
    r.watcher.start();
    r.set([pad([], [0, 0], false)]);
    r.tick();
    expect(r.events.at(-1)).toBe("lost");
    r.watcher.stop();
    expect(r.pending()).toBe(0);
  });
});
