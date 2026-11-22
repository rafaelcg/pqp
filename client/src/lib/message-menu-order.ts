import type { ContextMenuItemDef } from "@/components/ui/context-menu";

/*
 * The message menu's order under the redesign (the text channels canvas,
 * "O ⋯ de uma mensagem"): what you do with the message, then what you copy,
 * then what you do about the person, then the staff block under its own
 * heading. With the toggle off the menu keeps the order it is built in.
 *
 * One order for the desktop menu and the phone sheet. The only difference is
 * `nestCopy`: on desktop the copy rows fold into one "Copiar" row with a
 * submenu; on the sheet, where a submenu has nowhere to open, they stay flat,
 * in the same order the submenu lists them.
 */
// Your own message puts Fixar before Encaminhar; somebody else's, after.
const ACT_MINE = ["reply", "open-thread", "start-thread", "edit", "pin", "forward", "forum-answer"];
const ACT_OTHER = ["reply", "open-thread", "start-thread", "forward", "pin", "forum-answer"];
const MARK = ["mark-unread", "mark-read"];
/** Also the order inside the "Copiar" submenu. */
export const MESSAGE_MENU_COPY_IDS = ["copy-text", "copy-link", "copy-id"] as const;
const COPY = [...MARK, ...MESSAGE_MENU_COPY_IDS];
// Bloquear is not on the message menu: the author's profile card (the
// avatar or the name) offers it for everybody it applies to.
const PERSON = ["select", "report"];
const STAFF = ["mod-timeout", "mod-endTimeout", "mod-kick", "mod-ban"];

export interface MessageMenuOrderOptions {
  /**
   * Folds the copy rows into one row with a submenu. Only when two or more
   * of them are present; a lone copy row stays a row.
   */
  nestCopy?: Pick<ContextMenuItemDef, "icon" | "glyph" | "glyphKind"> & { label: string };
}

/**
 * Regroups `items` (separators are dropped and redrawn). `isMine` decides
 * where Apagar goes: the end of your own menu, or the staff block on
 * somebody else's. `staffHeading` labels that block.
 */
export function orderMessageMenu(
  items: readonly ContextMenuItemDef[],
  isMine: boolean,
  staffHeading: string,
  options: MessageMenuOrderOptions = {},
): ContextMenuItemDef[] {
  const byId = new Map(items.filter((item) => !item.separator).map((item) => [item.id, item]));
  const pick = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  const known = new Set([...ACT_MINE, ...COPY, ...PERSON, ...STAFF, "delete"]);
  const rest = [...byId.values()].filter((item) => !known.has(item.id));
  const person = pick(isMine ? [...PERSON, "delete"] : PERSON);
  // Apagar sits before the ban, which on a message is "Apagar e banir".
  const staff = pick(isMine ? STAFF : ["mod-timeout", "mod-endTimeout", "mod-kick", "delete", "mod-ban"]);
  const copies = pick(MESSAGE_MENU_COPY_IDS);
  const copyGroup =
    options.nestCopy && copies.length > 1
      ? [
          {
            id: "copy",
            label: options.nestCopy.label,
            icon: options.nestCopy.icon,
            glyph: options.nestCopy.glyph,
            glyphKind: options.nestCopy.glyphKind,
            submenu: copies,
          } satisfies ContextMenuItemDef,
        ]
      : copies;
  const groups = [pick(isMine ? ACT_MINE : ACT_OTHER), [...pick(MARK), ...copyGroup, ...rest], person];
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
