/**
 * Which voice room "Chama pra call" starts on, and whether the sticker will
 * be open once posted.
 *
 * The server keeps a call sticker live only while its AUTHOR is in the room
 * (design decision 26: "A call acabou" when the room empties or the author
 * leaves it). So the room worth offering first is the one the author is in,
 * not merely the busiest one: a sticker for a room the author is not in is
 * posted already closed, with no join button for anyone.
 */

export interface CallRoomOption {
  id: string;
  occupants: readonly { id: string }[];
}

export function authorInRoom(room: CallRoomOption | null | undefined, meId: string): boolean {
  return Boolean(room?.occupants.some((occupant) => occupant.id === meId));
}

export function defaultCallRoom(rooms: readonly CallRoomOption[], meId: string): string | null {
  const mine = rooms.find((room) => authorInRoom(room, meId));
  if (mine) {
    return mine.id;
  }
  const busiest = [...rooms].sort((a, b) => b.occupants.length - a.occupants.length)[0];
  return busiest?.id ?? null;
}
