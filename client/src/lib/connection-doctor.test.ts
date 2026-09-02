import { describe, expect, it } from "vitest";
import { adviseFrom, runConnectionChecks, type CheckResult } from "./connection-doctor";

function r(id: CheckResult["id"], verdict: CheckResult["verdict"], detail = ""): CheckResult {
  return { id, verdict, detail, ms: 1 };
}

describe("adviseFrom", () => {
  it("blames the network before the session when the API itself is unreachable", () => {
    expect(adviseFrom([r("api", "fail"), r("token", "fail"), r("socket", "fail")], 5)).toBe(
      "apiUnreachable",
    );
  });

  it("a token fetch that never returns is its own case", () => {
    expect(adviseFrom([r("api", "ok"), r("token", "fail", "timeout")], 0)).toBe("tokenStuck");
    expect(adviseFrom([r("api", "ok"), r("token", "fail", "null")], 0)).toBe("signInAgain");
  });

  it("a socket refused twice in a row means sign in again, once means blocked", () => {
    const base = [r("api", "ok"), r("token", "ok"), r("socket", "fail", "unauthorized")];
    expect(adviseFrom(base, 2)).toBe("signInAgain");
    expect(adviseFrom(base, 1)).toBe("socketBlocked");
  });

  it("no relay with STUN fine is a relay block; neither is no UDP at all", () => {
    const base = [r("api", "ok"), r("token", "ok"), r("socket", "ok")];
    expect(adviseFrom([...base, r("stun", "ok"), r("turn", "fail")], 0)).toBe("relayBlocked");
    expect(adviseFrom([...base, r("stun", "fail"), r("turn", "fail")], 0)).toBe("noUdp");
    expect(adviseFrom([...base, r("stun", "ok"), r("turn", "ok")], 0)).toBe("none");
  });
});

describe("runConnectionChecks", () => {
  const transport = {
    getStatus: () => "reconnecting" as const,
    getLastClose: () => ({ code: 4401, reason: "Unauthorized", at: 0 }),
    getUnauthorizedStreak: () => 3,
  };

  it("runs the HTTP and token checks and reports the socket state, skipping ICE without WebRTC", async () => {
    const report = await runConnectionChecks({
      transport,
      getToken: async () => null,
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
      peerConnection: undefined,
    });
    const by = Object.fromEntries(report.results.map((x) => [x.id, x]));
    expect(by.api.verdict).toBe("ok");
    expect(by.token.verdict).toBe("fail");
    expect(by.socket.verdict).toBe("fail");
    expect(by.socket.detail).toContain("4401");
    expect(by.stun.verdict).toBe("skip");
    expect(report.advice).toBe("signInAgain");
  });

  it("reports an unreachable API as such", async () => {
    const report = await runConnectionChecks({
      transport,
      getToken: async () => "t",
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      peerConnection: undefined,
    });
    expect(report.results[0]).toMatchObject({ id: "api", verdict: "fail" });
    expect(report.advice).toBe("apiUnreachable");
  });
});
