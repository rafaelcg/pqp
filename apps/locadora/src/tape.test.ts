import { describe, expect, it } from "vitest";
import { PqpAppError } from "@pqp/app-sdk";
import { chooseTape, type TapeHost } from "./tape";

const bytes = (n: number) => new Uint8Array(n).buffer;

function host(overrides: Partial<{ pick: () => Promise<{ bytes: ArrayBuffer; ext: string } | null>; get: (name: string) => Promise<ArrayBuffer> }> = {}) {
  const asked: string[] = [];
  const value: TapeHost = {
    files: { pickLocal: overrides.pick ?? (async () => ({ bytes: bytes(16), ext: ".gba" })) },
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
    ] as const) {
      const h = host({ pick: async () => ({ bytes: bytes(4), ext }) });
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

  it("an asset that cannot be fetched is a load problem", async () => {
    const h = host({ get: async () => { throw new PqpAppError("unavailable"); } });
    expect(await chooseTape(h.value)).toEqual({ kind: "problem", problem: "load" });
  });

  it("hands the bytes on untouched and never has a name to hand on", async () => {
    const rom = new Uint8Array([1, 2, 3, 4]).buffer;
    const h = host({ pick: async () => ({ bytes: rom, ext: ".nes" }) });
    const outcome = await chooseTape(h.value);
    if (outcome.kind !== "ready") throw new Error("expected ready");
    expect(outcome.rom).toBe(rom);
    expect(Object.keys(outcome).sort()).toEqual(["core", "coreData", "ext", "kind", "report", "rom"]);
  });
});
