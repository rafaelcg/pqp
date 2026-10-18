import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * One clip at a time per group. Clips that share a group name take turns:
 * of those on screen, only the leader plays. The leader is, in order:
 *
 * 1. the clip the visitor last started with its play button (it claims the
 *    group until it is paused or leaves the screen),
 * 2. the clip under the mouse or holding keyboard focus,
 * 3. the clip nearest the centre of the viewport.
 *
 * Distance is measured from each clip's centre to the viewport's, in 2D, so
 * tiles side by side in one row still differ; an exact tie goes to the first
 * in page order. The current leader keeps its place until another clip is
 * clearly nearer (a tenth of the viewport height), so a scroll that rests
 * between two never flickers. A clip the visitor paused keeps its place too:
 * pausing one never starts another.
 *
 * One passive scroll listener serves every group, attached only while some
 * member is on screen. A scroll asks for one frame, which reads the rects of
 * the members on screen and calls React only when a leader changes.
 */

interface Member {
  el: HTMLElement;
  eligible: boolean;
  hovered: boolean;
  /** When the visitor started this clip (a rising counter), or 0. */
  claimedAt: number;
  setLeader: (leader: boolean) => void;
}

interface Group {
  members: Set<Member>;
  leader: Member | null;
}

const groups = new Map<string, Group>();
let claims = 0;
let frame = 0;
let listening = false;

function anyEligible(): boolean {
  for (const g of groups.values()) for (const m of g.members) if (m.eligible) return true;
  return false;
}

function listen(on: boolean) {
  if (on === listening) return;
  listening = on;
  if (on) {
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  } else {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  }
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(elect);
}

const pageOrder = (a: Member, b: Member) =>
  a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

function elect() {
  frame = 0;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const margin = window.innerHeight * 0.1;
  const changes: [Member | null, Member | null][] = [];

  // Reads first...
  for (const g of groups.values()) {
    const eligible = [...g.members].filter((m) => m.eligible).sort(pageOrder);
    let next: Member | null = null;
    for (const m of eligible) if (m.claimedAt > (next?.claimedAt ?? 0)) next = m;
    next ??= eligible.find((m) => m.hovered) ?? null;
    if (!next && eligible.length > 0) {
      let best: Member | null = null;
      let bestD = Infinity;
      let currentD = Infinity;
      for (const m of eligible) {
        const r = m.el.getBoundingClientRect();
        const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
        if (m === g.leader) currentD = d;
        if (d < bestD - 0.5) {
          best = m;
          bestD = d;
        }
      }
      next = g.leader?.eligible && currentD - bestD < margin ? g.leader : best;
    }
    if (next !== g.leader) {
      changes.push([g.leader, next]);
      g.leader = next;
    }
  }
  // ...then writes.
  for (const [prev, next] of changes) {
    prev?.setLeader(false);
    next?.setLeader(true);
  }
  listen(anyEligible());
}

/**
 * Joins `ref`'s element to the named group and returns whether it leads (may
 * play) right now. `eligible`: on screen with footage to play. `hovered`: a
 * mouse is over it or focus is inside it. `claimed`: the visitor started it.
 * Without a group name it does nothing and returns false.
 */
export function useClipGroup(
  name: string | undefined,
  ref: RefObject<HTMLElement | null>,
  state: { eligible: boolean; hovered: boolean; claimed: boolean },
): boolean {
  const [leader, setLeader] = useState(false);
  const member = useRef<Member | null>(null);
  const wasClaimed = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!name || !el) return;
    let g = groups.get(name);
    if (!g) {
      g = { members: new Set(), leader: null };
      groups.set(name, g);
    }
    const m: Member = { el, eligible: false, hovered: false, claimedAt: 0, setLeader };
    g.members.add(m);
    member.current = m;
    wasClaimed.current = false;
    return () => {
      const group = groups.get(name);
      if (group) {
        group.members.delete(m);
        if (group.leader === m) group.leader = null;
        if (group.members.size === 0) groups.delete(name);
      }
      member.current = null;
      setLeader(false);
      schedule();
    };
  }, [name, ref]);

  const { eligible, hovered, claimed } = state;
  useEffect(() => {
    const m = member.current;
    if (!m) return;
    m.eligible = eligible;
    m.hovered = hovered;
    // A new press of play is a new claim; it outranks every older one.
    if (claimed && !wasClaimed.current) m.claimedAt = ++claims;
    if (!claimed) m.claimedAt = 0;
    wasClaimed.current = claimed;
    if (eligible) listen(true);
    schedule();
  }, [name, eligible, hovered, claimed]);

  return Boolean(name) && leader;
}
