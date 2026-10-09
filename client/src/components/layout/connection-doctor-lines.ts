import type { CheckId, CheckResult } from "@/lib/connection-doctor";
import type { MessageKey } from "@/lib/i18n";

/** A message key and the slots it fills. */
export interface DoctorLine {
  key: MessageKey;
  params?: { ms: number };
}

/**
 * What a check says under its name, in plain words.
 *
 * `CheckResult.detail` is for the copied report: HTTP codes, candidate flags,
 * the browser's own error names. A green row that reads "HTTP 401" looks like
 * a failure, so the dialog never shows it. The report keeps the raw text.
 *
 * `undefined` is a check that has not answered yet. `current` is whether it
 * is the one being waited on: the network checks can take up to eight
 * seconds, and only the row actually running says so.
 */
export function doctorLine(
  id: CheckId,
  result: CheckResult | undefined,
  current = true,
): DoctorLine {
  if (!result) {
    return {
      key:
        current && (id === "stun" || id === "turn")
          ? "settings.voice.doctor.pendingSlow"
          : "settings.voice.doctor.pending",
    };
  }
  if (result.detail === "no WebRTC") {
    return { key: "settings.voice.doctor.noWebrtc" };
  }
  if (result.verdict === "fail" && result.detail === "timeout") {
    return { key: "settings.voice.doctor.timeout" };
  }
  switch (id) {
    case "api":
      if (result.verdict === "ok") {
        return result.ms > 0
          ? { key: "settings.voice.doctor.api.ok", params: { ms: result.ms } }
          : { key: "settings.voice.doctor.api.okNoTime" };
      }
      return { key: "settings.voice.doctor.api.fail" };
    case "token":
      return {
        key:
          result.verdict === "ok"
            ? "settings.voice.doctor.token.ok"
            : "settings.voice.doctor.token.fail",
      };
    case "socket":
      return {
        key:
          result.verdict === "ok"
            ? "settings.voice.doctor.socket.ok"
            : "settings.voice.doctor.socket.fail",
      };
    case "stun":
      return {
        key:
          result.verdict === "ok"
            ? "settings.voice.doctor.stun.ok"
            : "settings.voice.doctor.stun.fail",
      };
    case "turn":
      if (result.verdict === "skip") {
        return {
          key:
            result.detail === "no token"
              ? "settings.voice.doctor.skipNoSession"
              : "settings.voice.doctor.turn.none",
        };
      }
      return {
        key:
          result.verdict === "ok"
            ? "settings.voice.doctor.turn.ok"
            : "settings.voice.doctor.turn.fail",
      };
  }
}
