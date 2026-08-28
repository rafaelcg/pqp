/** Move one entry in a ranked list. No-op when the indexes are the same or out of range. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  ) {
    return list;
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Which slot the pointer is over. `mids` are the vertical centres of the
 * current movable rows, top to bottom. Returns a clamped index.
 */
export function dropIndexFromPointer(pointerY: number, mids: number[]): number {
  if (mids.length === 0) {
    return 0;
  }
  for (let index = 0; index < mids.length; index += 1) {
    if (pointerY < mids[index]!) {
      return index;
    }
  }
  return mids.length - 1;
}
