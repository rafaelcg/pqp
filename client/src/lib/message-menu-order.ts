import type { ContextMenuItemDef } from "@/components/ui/context-menu";

/*
 * The message menu's order under the redesign (the text channels canvas,
 * "O ⋯ de uma mensagem"): what you do with the message, then what you copy,
 * then what you do about the person, then the staff block under its own
 * heading. With the toggle off the menu keeps the order it is built in.
 */
const ACT = ["reply", "open-thread", "start-thread", "edit", "pin", "forward", "forum-answer"];
const COPY = ["mark-unread", "mark-read", "copy-text", "copy-link", "copy-id"];
const PERSON = ["select", "block", "report"];
const STAFF = ["mod-timeout", "mod-endTimeout", "mod-kick", "mod-ban"];

/**
 * Regroups `items` (separators are dropped and redrawn). `isMine` decides
 * where Apagar goes: the end of your own menu, or the staff block on
 * somebody else's. `staffHeading` labels that block.
 */
export function orderMessageMenu(
  items: readonly ContextMenuItemDef[],
  isMine: boolean,
  staffHeading: string,
): ContextMenuItemDef[] {
  const byId = new Map(items.filter((item) => !item.separator).map((item) => [item.id, item]));
  const pick = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  const known = new Set([...ACT, ...COPY, ...PERSON, ...STAFF, "delete"]);
  const rest = [...byId.values()].filter((item) => !known.has(item.id));
  const person = pick(isMine ? [...PERSON, "delete"] : PERSON);
  const staff = pick(isMine ? STAFF : [...STAFF, "delete"]);
  const groups = [pick(ACT), [...pick(COPY), ...rest], person];
  const out: ContextMenuItemDef[] = [];
  for (const group of groups) {
    if (group.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push({ id: `sep-${group[0].id}`, label: "", separator: true });
    }
    out.push(...group);
  }
  if (staff.length > 0) {
    if (out.length > 0) {
      out.push({ id: "sep-staff", label: "", separator: true });
    }
    out.push({ id: "staff-heading", label: staffHeading, heading: true }, ...staff);
  }
  return out;
}
