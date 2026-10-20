import { describe, expect, it } from "vitest";
import { PqpAppError } from "@pqp/app-sdk";
import { chooseTape, loadNotices, pickTape, type TapeHost } from "./tape";
import { cartridgeFor, nesCartridge } from "./test-roms";

const bytes = (n: number) => new Uint8Array(n).buffer;

function host(overrides: Partial<{ pick: () => Promise<{ bytes: ArrayBuffer; ext: string } | null>; get: (name: string) => Promise<ArrayBuffer> }> = {}) {
  const asked: string[] = [];
  const value: TapeHost = {
    files: { pickLocal: overrides.pick ?? (async () => ({ bytes: cartridgeFor(".gba"), ext: ".gba" })) },
    assets: {
      get: async (name) => {
        asked.push(name);
        return overrides.get ? overrides.get(name) : bytes(8);
      },
    },
  };
  return { value, asked };
}

describe("choosing a game", () => {
  it("picks the core from the extension and fetches exactly that core's two files", async () => {
    for (const [ext, data, report] of [
      [".nes", "fceumm-core.pqpc", "fceumm.json"],
      [".gb", "mgba-core.pqpc", "mgba.json"],
      [".gbc", "mgba-core.pqpc", "mgba.json"],
      [".gba", "mgba-core.pqpc", "mgba.json"],
      [".sfc", "bsnes-core.pqpc", "bsnes.json"],
      [".smc", "bsnes-core.pqpc", "bsnes.json"],
    ] as const) {
      const h = host({ pick: async () => ({ bytes: cartridgeFor(ext), ext }) });
      const outcome = await chooseTape(h.value);
      expect(outcome.kind).toBe("ready");
      expect([...h.asked].sort()).toEqual([data, report].sort());
    }
  });

  it("says when the file was picked, before the slow part", async () => {
    const order: string[] = [];
    const h = host({ get: async () => (order.push("assets"), bytes(1)) });
    await chooseTape(h.value, () => order.push("picked"));
    expect(order[0]).toBe("picked");
  });

  it("a cancelled picker is not a problem and fetches nothing", async () => {
    const h = host({ pick: async () => null });
    expect(await chooseTape(h.value)).toEqual({ kind: "cancelled" });
    expect(h.asked).toEqual([]);
  });

  it("a file that is not a game is refused before anything is fetched: empty, text, zeros, the wrong size", async () => {
    const text = new TextEncoder().encode("this is a letter, not a cartridge. ".repeat(900)).buffer as ArrayBuffer;
    const cases: Array<[string, string, ArrayBuffer]> = [
      ["empty .nes", ".nes", new ArrayBuffer(0)],
      ["text as .nes", ".nes", text],
      ["text as .gba", ".gba", text],
      ["text as .gb", ".gb", text],
      ["a 24 MB file of zeros as .gba", ".gba", new ArrayBuffer(24 * 1024 * 1024)],
      ["zeros as .gbc", ".gbc", new ArrayBuffer(0x8000)],
      ["a 5 byte .gba", ".gba", new ArrayBuffer(5)],
      ["a .nes the header of which is cut off", ".nes", nesCartridge().slice(0, 4000).buffer as ArrayBuffer],
    ];
    for (const [label, ext, data] of cases) {
      const h = host({ pick: async () => ({ bytes: data, ext }) });
      expect(await chooseTape(h.value, () => { throw new Error("no loading screen"); }), label).toEqual({ kind: "problem", problem: "invalid" });
      expect(h.asked, label).toEqual([]);
    }
  });

  it("a file the frame does not run is refused before anything is fetched", async () => {
    const h = host({ pick: async () => ({ bytes: bytes(4), ext: ".zip" }) });
    expect(await chooseTape(h.value)).toEqual({ kind: "problem", problem: "unsupported" });
    expect(h.asked).toEqual([]);
  });

  it("maps the host's refusals: too large, not allowed, and anything else is a load problem", async () => {
    const fail = (code: ConstructorParameters<typeof PqpAppError>[0]) => host({ pick: async () => { throw new PqpAppError(code); } });
    expect(await chooseTape(fail("too-large").value)).toEqual({ kind: "problem", problem: "too-big" });
    expect(await chooseTape(fail("not-allowed").value)).toEqual({ kind: "problem", problem: "unsupported" });
    expect(await chooseTape(fail("unavailable").value)).toEqual({ kind: "problem", problem: "load" });
    expect(await chooseTape(host({ pick: async () => { throw new Error("boom"); } }).value)).toEqual({ kind: "problem", problem: "load" });
  });

  it("a .locadora file is a bundle: its bytes go to the import, no core is fetched and it never reaches the emulator", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 3, 4]);
    const h = host({ pick: async () => ({ bytes: zip.buffer, ext: ".locadora" }) });
    const outcome = await chooseTape(h.value, () => {
      throw new Error("no loading screen for a bundle");
    });
    expect(outcome).toEqual({ kind: "bundle", bytes: zip });
    expect(h.asked).toEqual([]);
    expect(await pickTape(host({ pick: async () => ({ bytes: zip.buffer, ext: ".LOCADORA" }) }).value)).toEqual({ kind: "bundle", bytes: zip });
  });

  it("pickTape alone hands a game back with its extension and fetches nothing", async () => {
    const h = host({ pick: async () => ({ bytes: bytes(4), ext: ".gb" }) });
    // the picker alone judges nothing: "Falta a fita" attaches by hash, which is a stricter check than any header
    const outcome = await pickTape(h.value);
    expect(outcome.kind).toBe("file");
    expect(h.asked).toEqual([]);
  });

  it("an asset that cannot be fetched is a load problem", async () => {
    const h = host({ get: async () => { throw new PqpAppError("unavailable"); } });
    expect(await chooseTape(h.value)).toEqual({ kind: "problem", problem: "load" });
  });

  it("hands the bytes on untouched and never has a name to hand on", async () => {
    const rom = cartridgeFor(".nes");
    const h = host({ pick: async () => ({ bytes: rom, ext: ".nes" }) });
    const outcome = await chooseTape(h.value);
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(outcome.rom).toBe(rom);
    expect(Object.keys(outcome).sort()).toEqual(["core", "coreData", "ext", "kind", "report", "rom"]);
  });
});

describe("the third-party notices", () => {
  it("reads notices.txt from the host's assets as text", async () => {
    const asked: string[] = [];
    const text = await loadNotices({
      assets: {
        get: async (name) => {
          asked.push(name);
          return new TextEncoder().encode("EmulatorJS 4.2.3 (GPL-3.0-only)").buffer as ArrayBuffer;
        },
      },
    });
    expect(asked).toEqual(["notices.txt"]);
    expect(text).toBe("EmulatorJS 4.2.3 (GPL-3.0-only)");
  });

  it("is null when the host cannot hand them over", async () => {
    expect(await loadNotices({ assets: { get: async () => { throw new PqpAppError("unavailable"); } } })).toBeNull();
  });
});
