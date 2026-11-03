import type { ReportReason } from "@pqp/shared";
import type { MessageKey } from "@/lib/i18n";

/**
 * The translated name of each stored report reason. Under the redesign the
 * report dialog and "Tuas denúncias" read these; with the toggle off the
 * dialog still shows the English `REPORT_REASON_LABELS` from shared.
 */
const KEYS: Record<ReportReason, MessageKey> = {
  spam: "report.reason.spam",
  harassment: "report.reason.harassment",
  hate_speech: "report.reason.hate_speech",
  violence: "report.reason.violence",
  sexual_content: "report.reason.sexual_content",
  self_harm: "report.reason.self_harm",
  illegal_content: "report.reason.illegal_content",
  minor_sexual: "report.reason.minor_sexual",
  other: "report.reason.other",
};

export function reportReasonKey(reason: ReportReason): MessageKey {
  return KEYS[reason];
}
