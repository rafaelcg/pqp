import { describe, expect, it } from "vitest";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { orderMessageMenu } from "./message-menu-order";

const item = (id: string): ContextMenuItemDef => ({ id, label: id });
const ids = (items: ContextMenuItemDef[]) => items.map((one) => (one.separator ? "|" : one.id));

describe("orderMessageMenu", () => {
  it("groups your own message: act, copy, then Apagar", () => {
    const built = ["reply", "start-thread", "copy-text", "copy-id", "copy-link", "forward", "mark-unread", "edit", "pin", "delete", "select"].map(item);
    expect(ids(orderMessageMenu(built, true, "Staff"))).toEqual([
      "reply", "start-thread", "edit", "pin", "forward", "|",
      "mark-unread", "copy-text", "copy-link", "copy-id", "|",
      "select", "delete",
    ]);
  });

  it("puts the staff block last on somebody else's message, with Apagar in it", () => {
    const built = ["reply", "copy-text", "forward", "pin", "delete", "report", "block", "mod-timeout", "mod-ban"].map(item);
    expect(ids(orderMessageMenu(built, false, "Staff"))).toEqual([
      "reply", "forward", "pin", "|",
      "copy-text", "|",
      "block", "report", "|",
      "staff-heading", "mod-timeout", "delete", "mod-ban",
    ]);
  });

  it("drops separators it was given and keeps an item it does not know", () => {
    const built = [item("reply"), { id: "sep-reply", label: "", separator: true }, item("copy-text"), item("something-new")];
    expect(ids(orderMessageMenu(built, false, "Staff"))).toEqual(["reply", "|", "copy-text", "something-new"]);
  });

  it("draws no heading when there is nothing for staff", () => {
    const built = ["reply", "report"].map(item);
    expect(ids(orderMessageMenu(built, false, "Staff"))).toEqual(["reply", "|", "report"]);
  });
});
