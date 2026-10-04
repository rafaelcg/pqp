import { describe, expect, it } from "vitest";
import { doctorLine } from "@/components/layout/connection-doctor-lines";
import type { CheckResult } from "@/lib/connection-doctor";
import en from "@/locales/en/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";

function r(
  id: CheckResult["id"],
  verdict: CheckResult["verdict"],
  detail: string,
  ms = 10,
): CheckResult {
  return { id, verdict, detail, ms };
}

describe("doctorLine", () => {
  it("never shows the raw detail: an HTTP 401 on a green row reads as success", () => {
    expect(doctorLine("api", r("api", "ok", "HTTP 401"))).toEqual({
      key: "settings.voice.doctor.api.ok",
      params: { ms: 10 },
    });
    expect(ptBR["settings.voice.doctor.api.ok"]).toBe("Servidor respondeu em {ms} ms");
  });

  it("says the same short thing for the other greens", () => {
    expect(doctorLine("token", r("token", "ok", "present")).key).toBe(
      "settings.voice.doctor.token.ok",
    );
    expect(doctorLine("socket", r("socket", "ok", "online")).key).toBe(
      "settings.voice.doctor.socket.ok",
    );
    expect(doctorLine("stun", r("stun", "ok", "host=true srflx=true")).key).toBe(
      "settings.voice.doctor.stun.ok",
    );
  });

  it("tells the three ways a relay row can be skipped apart", () => {
    expect(doctorLine("turn", r("turn", "skip", "no relay configured", 0)).key).toBe(
      "settings.voice.doctor.turn.none",
    );
    expect(doctorLine("turn", r("turn", "skip", "no token", 0)).key).toBe(
      "settings.voice.doctor.skipNoSession",
    );
    expect(doctorLine("stun", r("stun", "skip", "no WebRTC", 0)).key).toBe(
      "settings.voice.doctor.noWebrtc",
    );
  });

  it("names a timeout as a timeout, and any other failure by its check", () => {
    expect(doctorLine("api", r("api", "fail", "timeout", 8000)).key).toBe(
      "settings.voice.doctor.timeout",
    );
    expect(doctorLine("api", r("api", "fail", "TypeError")).key).toBe(
      "settings.voice.doctor.api.fail",
    );
    expect(doctorLine("turn", r("turn", "fail", "relay=false")).key).toBe(
      "settings.voice.doctor.turn.fail",
    );
  });

  it("leaves the milliseconds out when a check was instant", () => {
    expect(doctorLine("api", r("api", "ok", "HTTP 200", 0)).key).toBe(
      "settings.voice.doctor.api.okNoTime",
    );
  });

  it("only the row being waited on promises up to eight seconds", () => {
    expect(doctorLine("stun", undefined, true).key).toBe(
      "settings.voice.doctor.pendingSlow",
    );
    expect(doctorLine("stun", undefined, false).key).toBe(
      "settings.voice.doctor.pending",
    );
    expect(doctorLine("api", undefined, true).key).toBe("settings.voice.doctor.pending");
  });

  it("has every line in English and Portuguese", () => {
    const keys = [
      "settings.voice.doctor.api.ok",
      "settings.voice.doctor.timeout",
      "settings.voice.doctor.pendingSlow",
      "settings.voice.doctor.footnote",
    ] as const;
    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(ptBR[key]).toBeTruthy();
    }
  });
});
