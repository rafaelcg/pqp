import type { Channel } from "@pqp/shared";
import type { Translator } from "@/lib/i18n";

export type DeleteDialogCopy = {
  title: string;
  description: string;
  confirmLabel: string;
};

/**
 * What the delete confirm says. A category holds no messages and the server
 * sets its children's `parent_id` to NULL (`ON DELETE SET NULL`), so the
 * channels inside stay and move out of the category. The channel copy is the
 * one that warns about message loss.
 */
export function deleteDialogCopy(
  channel: Pick<Channel, "name" | "type"> | null | undefined,
  t: Translator["t"],
): DeleteDialogCopy {
  if (channel?.type === "category") {
    return {
      title: t("chrome.deleteCategory"),
      description: t("chrome.deleteCategoryConfirm", { name: channel.name }),
      confirmLabel: t("chrome.deleteCategory"),
    };
  }
  return {
    title: t("chrome.deleteChannel"),
    description: channel
      ? t("chrome.deleteChannelConfirmNamed", { name: channel.name })
      : t("chrome.deleteChannelConfirm"),
    confirmLabel: t("chrome.deleteChannel"),
  };
}
