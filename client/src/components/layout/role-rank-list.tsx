import { isRoleOrderLocked } from "@pqp/shared";
import { GripVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { dropIndexFromPointer, moveItem } from "@/lib/role-drag";
import { useTranslation } from "@/lib/i18n";
import type { ServerRole } from "@/lib/api";

const DRAG_THRESHOLD_PX = 5;

type Press = {
  id: string;
  fromIndex: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

type Drag = Press & {
  pointerX: number;
  pointerY: number;
  overIndex: number;
};

export function RoleRankList({
  roles,
  selectedId,
  disabled,
  labelFor,
  onSelect,
  onReorder,
}: {
  roles: ServerRole[];
  selectedId: string | null;
  disabled: boolean;
  labelFor: (role: ServerRole) => string;
  onSelect: (role: ServerRole) => void;
  onReorder: (movableIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  const pressRef = useRef<Press | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const didDragRef = useRef(false);
  const movableIdsRef = useRef<string[]>([]);
  const onSelectRef = useRef(onSelect);
  const onReorderRef = useRef(onReorder);
  const [drag, setDrag] = useState<Drag | null>(null);

  onSelectRef.current = onSelect;
  onReorderRef.current = onReorder;

  const movable = roles.filter((role) => !isRoleOrderLocked(role));
  const movableIds = movable.map((role) => role.id);
  movableIdsRef.current = movableIds;
  const previewIds = drag
    ? moveItem(movableIds, drag.fromIndex, drag.overIndex)
    : movableIds;
  const byId = new Map(roles.map((role) => [role.id, role]));
  const owner = roles.find((role) => role.systemKey === "owner");
  const everyone = roles.find((role) => role.isEveryone);
  const shown = [
    ...(owner ? [owner] : []),
    ...previewIds
      .map((id) => byId.get(id))
      .filter((role): role is ServerRole => Boolean(role)),
    ...(everyone ? [everyone] : []),
  ];
  const dragging = drag ? byId.get(drag.id) : null;

  function midpoints(): number[] {
    const root = listRef.current;
    if (!root) {
      return [];
    }
    return [...root.querySelectorAll<HTMLElement>("[data-role-movable]")].map(
      (node) => {
        const box = node.getBoundingClientRect();
        return box.top + box.height / 2;
      },
    );
  }

  function clearCursor() {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function activate(press: Press, pointerX: number, pointerY: number): Drag {
    didDragRef.current = true;
    const next: Drag = {
      ...press,
      pointerX,
      pointerY,
      overIndex: press.fromIndex,
    };
    dragRef.current = next;
    setDrag(next);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return next;
  }

  function updateDrag(pointerX: number, pointerY: number) {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    const overIndex = dropIndexFromPointer(pointerY, midpoints());
    const next = { ...current, pointerX, pointerY, overIndex };
    dragRef.current = next;
    setDrag(next);
  }

  function finish(commit: boolean) {
    const current = dragRef.current;
    const press = pressRef.current;
    pressRef.current = null;
    dragRef.current = null;
    setDrag(null);
    clearCursor();
    if (current) {
      if (commit && current.overIndex !== current.fromIndex) {
        onReorderRef.current(
          moveItem(movableIdsRef.current, current.fromIndex, current.overIndex),
        );
      }
      return;
    }
    if (commit && press) {
      const role = byId.get(press.id);
      if (role) {
        onSelectRef.current(role);
      }
    }
  }

  const finishRef = useRef(finish);
  finishRef.current = finish;
  const activateRef = useRef(activate);
  activateRef.current = activate;
  const updateDragRef = useRef(updateDrag);
  updateDragRef.current = updateDrag;

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const press = pressRef.current;
      if (!press) {
        return;
      }
      const dx = event.clientX - press.startX;
      const dy = event.clientY - press.startY;
      if (!dragRef.current) {
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          return;
        }
        activateRef.current(press, event.clientX, event.clientY);
      }
      updateDragRef.current(event.clientX, event.clientY);
    }

    function onUp() {
      if (pressRef.current || dragRef.current) {
        finishRef.current(true);
      }
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && (pressRef.current || dragRef.current)) {
        event.preventDefault();
        finishRef.current(false);
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
      clearCursor();
    };
  }, []);

  function startPress(role: ServerRole, event: React.PointerEvent<HTMLLIElement>) {
    if (disabled || isRoleOrderLocked(role) || event.button !== 0) {
      return;
    }
    const index = movableIds.indexOf(role.id);
    if (index < 0) {
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    pressRef.current = {
      id: role.id,
      fromIndex: index,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      width: box.width,
      height: box.height,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort. Window listeners still finish the drag.
    }
  }

  return (
    <>
      <ul ref={listRef} className="divide-y divide-ink-4/60">
        {shown.map((role) => {
          const pinned = isRoleOrderLocked(role);
          const selectedRow = role.id === selectedId;
          const isGhostSource = drag?.id === role.id;
          const label = labelFor(role);
          return (
            <li
              key={role.id}
              data-role-movable={pinned ? undefined : ""}
              role={pinned ? "listitem" : "button"}
              tabIndex={pinned || disabled ? -1 : 0}
              aria-grabbed={isGhostSource || undefined}
              aria-label={
                pinned ? label : `${label}. ${t("roles.dragHandle")}`
              }
              onPointerDown={(event) => startPress(role, event)}
              onClick={() => {
                if (didDragRef.current) {
                  didDragRef.current = false;
                  return;
                }
                onSelect(role);
              }}
              onKeyDown={(event) => {
                if (pinned || disabled) {
                  return;
                }
                const index = movableIds.indexOf(role.id);
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault();
                  onReorder(moveItem(movableIds, index, index - 1));
                }
                if (
                  event.key === "ArrowDown" &&
                  index >= 0 &&
                  index < movableIds.length - 1
                ) {
                  event.preventDefault();
                  onReorder(moveItem(movableIds, index, index + 1));
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(role);
                }
              }}
              className={cn(
                "flex touch-none items-center outline-none focus-visible:bg-signal/12",
                selectedRow && !isGhostSource && "bg-signal/12",
                !pinned && !disabled && !drag && "cursor-grab",
                Boolean(drag) && "cursor-grabbing",
                isGhostSource && "bg-ink-3/50",
              )}
            >
              <RoleRowFace
                name={label}
                color={role.color}
                muted={isGhostSource}
                handle={!pinned}
              />
            </li>
          );
        })}
      </ul>
      {drag && dragging
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[80] overflow-hidden rounded-xl bg-ink-2 shadow-[0_18px_40px_rgba(0,0,0,0.45)] ring-1 ring-ink-4"
              style={{
                width: drag.width,
                height: drag.height,
                left: drag.pointerX - drag.offsetX,
                top: drag.pointerY - drag.offsetY,
                transform: "scale(1.03) rotate(1deg)",
              }}
            >
              <RoleRowFace
                name={labelFor(dragging)}
                color={dragging.color}
                lifted
                handle
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function RoleRowFace({
  name,
  color,
  muted,
  lifted,
  handle,
}: {
  name: string;
  color: string | null;
  muted?: boolean;
  lifted?: boolean;
  handle?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-sm",
        muted && "opacity-35",
        lifted ? "font-medium text-paper" : "text-paper",
      )}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-ink-4/80"
        style={{ backgroundColor: color ?? "transparent" }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {handle ? (
        <GripVertical
          className="h-4 w-4 shrink-0 text-paper-muted"
          aria-hidden
        />
      ) : null}
    </div>
  );
}
