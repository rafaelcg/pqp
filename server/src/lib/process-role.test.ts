import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseProcessRole,
  processRole,
  runsColdJobs,
  servesTraffic,
} from "./process-role.js";

describe("WORKER_MODE", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unset is today's behaviour: one process does everything", () => {
    expect(processRole({})).toBe("all");
    expect(processRole({ WORKER_MODE: "" })).toBe("all");
    expect(runsColdJobs("all")).toBe(true);
    expect(servesTraffic("all")).toBe(true);
  });

  it("worker (or 1) runs jobs and nothing else", () => {
    for (const raw of ["worker", "1", "true", " Worker "]) {
      expect(parseProcessRole(raw)).toBe("worker");
    }
    expect(runsColdJobs("worker")).toBe(true);
    expect(servesTraffic("worker")).toBe(false);
  });

  it("api serves traffic and skips every cold job", () => {
    expect(parseProcessRole("api")).toBe("api");
    expect(runsColdJobs("api")).toBe(false);
    expect(servesTraffic("api")).toBe(true);
  });

  it("a typo falls back to all, loudly, never to nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseProcessRole("wroker")).toBeNull();
    expect(processRole({ WORKER_MODE: "wroker" })).toBe("all");
    expect(warn).toHaveBeenCalledOnce();
  });
});
