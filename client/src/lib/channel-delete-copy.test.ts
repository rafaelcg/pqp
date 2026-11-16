import { describe, expect, it } from "vitest";
import type { Translator } from "@/lib/i18n";
import { deleteDialogCopy } from "./channel-delete-copy";

const t = ((key: string, vars?: { name?: string }) =>
  vars?.name ? `${key}|${vars.name}` : key) as Translator["t"];

describe("deleteDialogCopy", () => {
  it("gives a category its own title, body and name", () => {
    expect(deleteDialogCopy({ name: "Jogos", type: "category" }, t)).toEqual({
      title: "chrome.deleteCategory",
      description: "chrome.deleteCategoryConfirm|Jogos",
      confirmLabel: "chrome.deleteCategory",
    });
  });

  it("keeps the message-loss copy for a channel and names it", () => {
    expect(deleteDialogCopy({ name: "geral", type: "text" }, t)).toEqual({
      title: "chrome.deleteChannel",
      description: "chrome.deleteChannelConfirmNamed|geral",
      confirmLabel: "chrome.deleteChannel",
    });
  });

  it("falls back to the unnamed channel copy when the row is gone", () => {
    expect(deleteDialogCopy(undefined, t).description).toBe(
      "chrome.deleteChannelConfirm",
    );
  });
});
