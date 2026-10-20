import { describe, expect, it } from "vitest";
import { PqpAppError } from "@pqp/app-sdk";
import { probeShare, setShared, spectatorNames, WATCHER_NAMES_SHOWN } from "./share";

const host = (request: (on: boolean) => Promise<boolean>) => ({ share: { request } });

describe("the share probe: the control is drawn only when the platform answers", () => {
  it("is on when a stop request is answered, and asks only to STOP sharing", async () => {
    const asked: boolean[] = [];
    expect(await probeShare(host(async (on) => (asked.push(on), false)))).toBe(true);
    expect(asked).toEqual([false]);
  });

  it("is off with the flag off: the host answers not-allowed", async () => {
    expect(await probeShare(host(async () => { throw new PqpAppError("not-allowed"); }))).toBe(false);
  });

  it("is off when there is no share flow here (a text channel), or the host is unreachable", async () => {
    expect(await probeShare(host(async () => { throw new PqpAppError("unavailable"); }))).toBe(false);
    expect(await probeShare(host(async () => { throw new PqpAppError("ended"); }))).toBe(false);
    expect(await probeShare(host(async () => { throw new Error("boom"); }))).toBe(false);
  });
});

describe("starting and stopping the share", () => {
  it("reports what the host says it is now", async () => {
    expect(await setShared(host(async (on) => on), true)).toEqual({ kind: "shared", on: true });
    expect(await setShared(host(async () => false), true)).toEqual({ kind: "shared", on: false });
  });

  it("tells a refusal from a failure", async () => {
    expect(await setShared(host(async () => { throw new PqpAppError("not-allowed"); }), true)).toEqual({ kind: "refused" });
    expect(await setShared(host(async () => { throw new PqpAppError("unavailable"); }), true)).toEqual({ kind: "failed" });
    expect(await setShared(host(async () => { throw new PqpAppError("rate-limited"); }), true)).toEqual({ kind: "failed" });
  });
});

describe("what a watcher is told they are watching", () => {
  const seat = (displayName: string, role = "player") => ({ displayName, role });

  it("names the players, never the other watchers", () => {
    expect(spectatorNames([seat("Ana"), seat("Bia"), seat("Caio", "spectator")])).toEqual({ shown: ["Ana", "Bia"], more: 0 });
  });

  it("stops at three names and counts the rest", () => {
    const players = ["A", "B", "C", "D", "E"].map((name) => seat(name));
    expect(spectatorNames(players)).toEqual({ shown: ["A", "B", "C"], more: 2 });
    expect(WATCHER_NAMES_SHOWN).toBe(3);
  });

  it("has nobody to name in an empty room", () => {
    expect(spectatorNames([])).toEqual({ shown: [], more: 0 });
    expect(spectatorNames([seat("Caio", "spectator")])).toEqual({ shown: [], more: 0 });
  });

  it("keeps a name a stranger typed as plain text, untouched", () => {
    expect(spectatorNames([seat("<b>x</b> $& {name}")]).shown).toEqual(["<b>x</b> $& {name}"]);
  });
});
