import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_FLOOR_MS,
  BUDGET_MIN_SAMPLES,
  BUDGET_PRIOR_MS,
  BudgetExceeded,
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_FAILURES,
  CircuitOpen,
  SFU_CALL_TIMEOUT_MS,
  budgetMsFor,
  classifyError,
  logPartialCoverage,
  resetSfuControlPlane,
  runRegionCall,
  sfuControlPlaneReport,
} from "./sfu-control-plane.js";

/**
 * The per-region fence around the API's control-plane calls to each SFU box:
 * what is measured, what a speculative read is allowed to take, when the
 * circuit opens and closes, what a failure line says, and that none of it
 * applies to a write or to a call for a room known to live there.
 */

function timeoutError(): Error {
  return Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });
}

const lines: string[] = [];

function failureLines(): string[] {
  return lines.filter((line) => line.includes("voice.sfuRegionCallFailed"));
}

function speculativeRead<T>(region: string, run: () => Promise<T>, call = "listRooms") {
  return runRegionCall({
    region,
    home: false,
    call,
    caller: "test",
    mode: "speculative",
    run,
  });
}

/** Fail `n` speculative reads against `region`, settling each. */
async function failTimes(region: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await speculativeRead(region, () => Promise.reject(timeoutError())).catch(() => {});
  }
}

describe("SFU control plane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    resetSfuControlPlane();
    lines.length = 0;
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    delete process.env.SFU_REGION_SCOPED_CALLS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.SFU_REGION_SCOPED_CALLS;
  });

  describe("classifyError", () => {
    it("names what the SDK and fetch throw", () => {
      expect(classifyError(timeoutError())).toBe("timeout");
      expect(classifyError(new Error("The operation was aborted due to timeout"))).toBe(
        "timeout",
      );
      expect(
        classifyError(Object.assign(new TypeError("fetch failed"), { cause: { code: "EAI_AGAIN" } })),
      ).toBe("dns");
      expect(
        classifyError(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
        ),
      ).toBe("connect-timeout");
      expect(
        classifyError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
      ).toBe("refused");
      expect(
        classifyError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })),
      ).toBe("reset");
      expect(classifyError(Object.assign(new Error("x"), { status: 503 }))).toBe("http-5xx");
      expect(classifyError(Object.assign(new Error("x"), { status: 401 }))).toBe("http-4xx");
      expect(classifyError(Object.assign(new Error("x"), { status: 404 }))).toBe("not-found");
      expect(classifyError(new BudgetExceeded("mia", 3000))).toBe("budget");
      expect(classifyError(new CircuitOpen("mia"))).toBe("circuit-open");
      expect(classifyError(new Error("boom"))).toBe("other");
    });
  });

  describe("measurement", () => {
    it("counts calls, failures by class and the latency of answers per region", async () => {
      for (const ms of [100, 200, 300, 400]) {
        const call = speculativeRead("mia", () => new Promise((resolve) => setTimeout(resolve, ms)));
        await vi.advanceTimersByTimeAsync(ms);
        await call;
      }
      await failTimes("mia", 1);
      const report = sfuControlPlaneReport(["sao", "mia"]);
      expect(report.mia).toMatchObject({
        calls: 5,
        failures: 1,
        failuresByClass: { timeout: 1 },
        circuitOpen: false,
        p50Ms: 200,
        p95Ms: 400,
        p99Ms: 400,
      });
      expect(report.sao).toMatchObject({ calls: 0, failures: 0, p50Ms: null });
    });

    it("counts a not-found as an answer, not a failure", async () => {
      await speculativeRead("mia", () =>
        Promise.reject(Object.assign(new Error("requested room does not exist"), { status: 404 })),
      ).catch(() => {});
      expect(sfuControlPlaneReport(["mia"]).mia).toMatchObject({ calls: 1, failures: 0 });
      expect(failureLines()).toEqual([]);
    });
  });

  describe("the budget", () => {
    it("is the prior until there is evidence, then four times the measured p99 inside the SDK bound", async () => {
      expect(budgetMsFor("lhr")).toBe(BUDGET_PRIOR_MS);
      for (let i = 0; i < BUDGET_MIN_SAMPLES; i++) {
        const call = speculativeRead("lhr", () => new Promise((resolve) => setTimeout(resolve, 400)));
        await vi.advanceTimersByTimeAsync(400);
        await call;
      }
      // 4 x 400 ms
      expect(budgetMsFor("lhr")).toBe(1600);

      for (let i = 0; i < BUDGET_MIN_SAMPLES; i++) {
        const call = speculativeRead("fast", () => new Promise((resolve) => setTimeout(resolve, 10)));
        await vi.advanceTimersByTimeAsync(10);
        await call;
      }
      expect(budgetMsFor("fast")).toBe(BUDGET_FLOOR_MS);

      for (let i = 0; i < BUDGET_MIN_SAMPLES; i++) {
        const call = speculativeRead("slow", () => new Promise((resolve) => setTimeout(resolve, 2500)));
        await vi.advanceTimersByTimeAsync(2500);
        await call;
      }
      expect(budgetMsFor("slow")).toBe(SFU_CALL_TIMEOUT_MS);
    });

    it("cuts a speculative read off at its budget, well before the SDK's own timeout", async () => {
      const call = speculativeRead("lhr", () => new Promise(() => {}));
      const outcome = call.then(
        () => "answered",
        (error: unknown) => classifyError(error),
      );
      await vi.advanceTimersByTimeAsync(BUDGET_PRIOR_MS - 1);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe("budget");
      expect(BUDGET_PRIOR_MS).toBeLessThan(SFU_CALL_TIMEOUT_MS);
    });

    it("never budgets a write, a pinned call or the home box", async () => {
      const slow = () => new Promise((resolve) => setTimeout(() => resolve("late"), 4500));
      const calls = [
        runRegionCall({ region: "mia", home: false, call: "removeParticipant", caller: "t", mode: "speculative", run: slow }),
        runRegionCall({ region: "mia", home: false, call: "listParticipants", caller: "t", mode: "pinned", run: slow }),
        runRegionCall({ region: "sao", home: true, call: "listParticipants", caller: "t", mode: "speculative", run: slow }),
        // Nothing will repeat a one-shot (a moderator's mute): never cut short.
        runRegionCall({ region: "mia", home: false, call: "listParticipants", caller: "t", mode: "oneshot", run: slow }),
      ];
      await vi.advanceTimersByTimeAsync(4500);
      await expect(Promise.all(calls)).resolves.toEqual(["late", "late", "late", "late"]);
    });
  });

  describe("the circuit", () => {
    it("opens after consecutive failures and skips a speculative read without calling the box", async () => {
      await failTimes("mia", CIRCUIT_FAILURES);
      expect(sfuControlPlaneReport(["mia"]).mia!.circuitOpen).toBe(true);
      expect(lines.some((line) => line.includes("voice.sfuRegionCircuit") && line.includes("state=open"))).toBe(true);

      const run = vi.fn().mockResolvedValue([]);
      await expect(speculativeRead("mia", run)).rejects.toBeInstanceOf(CircuitOpen);
      expect(run).not.toHaveBeenCalled();
      expect(sfuControlPlaneReport(["mia"]).mia!.skippedByCircuit).toBe(1);
    });

    it("does not count a skip as a failure, and never opens for the home box", async () => {
      for (let i = 0; i < CIRCUIT_FAILURES + 2; i++) {
        await runRegionCall({
          region: "sao",
          home: true,
          call: "listRooms",
          caller: "t",
          mode: "speculative",
          run: () => Promise.reject(timeoutError()),
        }).catch(() => {});
      }
      const run = vi.fn().mockResolvedValue([]);
      await runRegionCall({ region: "sao", home: true, call: "listRooms", caller: "t", mode: "speculative", run });
      expect(run).toHaveBeenCalledTimes(1);
      expect(sfuControlPlaneReport(["sao"]).sao!.circuitOpen).toBe(false);
    });

    it("lets calls for a room known to live there, and writes, through an open circuit", async () => {
      await failTimes("mia", CIRCUIT_FAILURES);
      const pinned = vi.fn().mockResolvedValue([]);
      await runRegionCall({ region: "mia", home: false, call: "listParticipants", caller: "t", mode: "pinned", run: pinned });
      expect(pinned).toHaveBeenCalledTimes(1);
      const write = vi.fn().mockResolvedValue(undefined);
      await runRegionCall({ region: "mia", home: false, call: "removeParticipant", caller: "t", mode: "speculative", run: write });
      expect(write).toHaveBeenCalledTimes(1);
      // And a read nothing will repeat: skipping it would be a change that is never applied.
      const oneshot = vi.fn().mockResolvedValue([]);
      await runRegionCall({ region: "mia", home: false, call: "listParticipants", caller: "t", mode: "oneshot", run: oneshot });
      expect(oneshot).toHaveBeenCalledTimes(1);
    });

    it("lets exactly one probe through after the cooldown, and closes on its success", async () => {
      await failTimes("mia", CIRCUIT_FAILURES);
      await vi.advanceTimersByTimeAsync(CIRCUIT_COOLDOWN_MS);

      let releaseProbe: (value: unknown[]) => void = () => {};
      const probe = vi.fn(() => new Promise<unknown[]>((resolve) => (releaseProbe = resolve)));
      const first = speculativeRead("mia", probe);
      const second = speculativeRead("mia", vi.fn().mockResolvedValue([]));
      await expect(second).rejects.toBeInstanceOf(CircuitOpen);
      releaseProbe([]);
      await first;
      expect(probe).toHaveBeenCalledTimes(1);
      expect(sfuControlPlaneReport(["mia"]).mia!.circuitOpen).toBe(false);
      expect(lines.some((line) => line.includes("voice.sfuRegionCircuit") && line.includes("state=closed"))).toBe(true);

      const after = vi.fn().mockResolvedValue([]);
      await speculativeRead("mia", after);
      expect(after).toHaveBeenCalledTimes(1);
    });

    it("re-opens when the probe fails", async () => {
      await failTimes("mia", CIRCUIT_FAILURES);
      await vi.advanceTimersByTimeAsync(CIRCUIT_COOLDOWN_MS);
      await failTimes("mia", 1);
      await expect(speculativeRead("mia", vi.fn())).rejects.toBeInstanceOf(CircuitOpen);
    });

    it("is switched off, with the budget, by the runtime flag", async () => {
      process.env.SFU_REGION_SCOPED_CALLS = "off";
      await failTimes("mia", CIRCUIT_FAILURES + 2);
      const run = vi.fn().mockResolvedValue([]);
      await speculativeRead("mia", run);
      expect(run).toHaveBeenCalledTimes(1);

      const slow = speculativeRead("lhr", () => new Promise((resolve) => setTimeout(() => resolve("late"), 4500)));
      await vi.advanceTimersByTimeAsync(4500);
      await expect(slow).resolves.toBe("late");
    });
  });

  describe("the failure line", () => {
    it("says what failed, for whom, how long it took against what budget, and how idle the region was", async () => {
      const first = speculativeRead("lhr", () => Promise.resolve([]));
      await first;
      await vi.advanceTimersByTimeAsync(20_000);
      const call = runRegionCall({
        region: "lhr",
        home: false,
        call: "listParticipants",
        caller: "mute",
        room: "room-1",
        mode: "speculative",
        run: () => new Promise((_, reject) => setTimeout(() => reject(timeoutError()), 2000)),
      });
      const settled = call.catch(() => {});
      await vi.advanceTimersByTimeAsync(2000);
      await settled;

      const [line] = failureLines();
      expect(line).toContain("region=lhr");
      expect(line).toContain("stage=listParticipants");
      expect(line).toContain("caller=mute");
      expect(line).toContain("room=room-1");
      expect(line).toContain("mode=speculative");
      expect(line).toContain("errorClass=timeout");
      expect(line).toContain("durationMs=2000");
      expect(line).toContain(`budgetMs=${BUDGET_PRIOR_MS}`);
      expect(line).toContain("idleMs=20000");
      expect(line).toContain("consecutiveFailures=1");
    });

    it("is one line per region per ten seconds, with a count of what it swallowed", async () => {
      await failTimes("mia", 2);
      expect(failureLines()).toHaveLength(1);
      await failTimes("lhr", 1);
      expect(failureLines()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(10_000);
      await failTimes("mia", 1);
      const mia = failureLines().filter((line) => line.includes("region=mia"));
      expect(mia).toHaveLength(2);
      // The circuit is open by now, so only the failures that actually ran count.
      expect(mia[1]).toContain("suppressed=");
    });

    it("keeps counting when it stops logging", async () => {
      await failTimes("mia", 2);
      expect(sfuControlPlaneReport(["mia"]).mia!.failures).toBe(2);
      expect(failureLines()).toHaveLength(1);
    });
  });

  describe("partial coverage", () => {
    it("is silent when every box answered and says which boxes did not otherwise", () => {
      logPartialCoverage({ caller: "mute", call: "listParticipants", answered: ["sao", "mia"], skipped: [], failed: [] });
      expect(lines.filter((line) => line.includes("voice.sfuRegionPartial"))).toEqual([]);

      logPartialCoverage({
        caller: "mute",
        call: "listParticipants",
        room: "room-1",
        answered: ["sao"],
        skipped: ["lhr"],
        failed: ["mia"],
      });
      const [line] = lines.filter((entry) => entry.includes("voice.sfuRegionPartial"));
      expect(line).toContain("answered=sao");
      expect(line).toContain("skipped=lhr");
      expect(line).toContain("failed=mia");

      logPartialCoverage({ caller: "mute", call: "listParticipants", answered: ["sao"], skipped: ["lhr"], failed: [] });
      expect(lines.filter((entry) => entry.includes("voice.sfuRegionPartial"))).toHaveLength(1);
    });
  });
});
