import type { ReportContext, ReportReason, ReportStatus } from "@pqp/shared";

/**
 * The account-report case at a glance.
 *
 * A report about an account has no message and no details, so the thing a
 * moderator has to judge is a SEQUENCE: made at 12:00, five strangers called
 * between 12:03 and 12:23, blocked at 12:24, reported at 12:25. The context
 * read returns the pieces (counts, timestamps, sanctions, other reports); this
 * puts them on one line in order.
 *
 * Pure, so the grouping can be pinned without a DOM.
 */

/** Cold contacts closer together than this read as one burst. */
export const BURST_GAP_MS = 30 * 60 * 1000;

export type TimelineEvent =
  | { kind: "account"; at: string }
  | {
      kind: "contacts";
      at: string;
      until: string;
      dms: number;
      calls: number;
    }
  | { kind: "blocked"; at: string }
  | { kind: "server-created"; at: string; name: string; members: number }
  | {
      kind: "other-report";
      at: string;
      id: string;
      reason: ReportReason;
      status: ReportStatus;
    }
  | { kind: "ban"; at: string; serverName: string }
  | { kind: "timeout"; at: string; serverName: string }
  | { kind: "this-report"; at: string };

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Collapse DM starts and missed calls into bursts. Both lists are timestamps
 * only (the server never names the other person), so a burst is "N
 * conversations and M calls between A and B".
 */
export function groupContacts(
  dmTimes: readonly string[],
  callTimes: readonly string[],
): Extract<TimelineEvent, { kind: "contacts" }>[] {
  const all = [
    ...dmTimes.map((at) => ({ at, call: false })),
    ...callTimes.map((at) => ({ at, call: true })),
  ].sort((a, b) => ms(a.at) - ms(b.at));

  const bursts: Extract<TimelineEvent, { kind: "contacts" }>[] = [];
  for (const entry of all) {
    const last = bursts.at(-1);
    if (last && ms(entry.at) - ms(last.until) <= BURST_GAP_MS) {
      last.until = entry.at;
      if (entry.call) {
        last.calls += 1;
      } else {
        last.dms += 1;
      }
      continue;
    }
    bursts.push({
      kind: "contacts",
      at: entry.at,
      until: entry.at,
      dms: entry.call ? 0 : 1,
      calls: entry.call ? 1 : 0,
    });
  }
  return bursts;
}

export function buildTimeline(
  context: ReportContext,
  reportCreatedAt: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (context.account) {
    events.push({ kind: "account", at: context.account.createdAt });
  }
  if (context.signals) {
    events.push(
      ...groupContacts(
        context.signals.dmsStarted.times,
        context.signals.callsPlaced.times,
      ),
    );
    if (context.signals.reporterBlockedAt) {
      events.push({ kind: "blocked", at: context.signals.reporterBlockedAt });
    }
  }
  for (const server of context.ownedServers) {
    events.push({
      kind: "server-created",
      at: server.createdAt,
      name: server.name,
      members: server.memberCount,
    });
  }
  for (const other of context.otherReports) {
    events.push({
      kind: "other-report",
      at: other.createdAt,
      id: other.id,
      reason: other.reason,
      status: other.status,
    });
  }
  for (const ban of context.sanctions.bans) {
    events.push({ kind: "ban", at: ban.createdAt, serverName: ban.serverName });
  }
  for (const timeout of context.sanctions.timeouts) {
    events.push({
      kind: "timeout",
      at: timeout.createdAt,
      serverName: timeout.serverName,
    });
  }
  events.push({ kind: "this-report", at: reportCreatedAt });
  // Stable for equal instants: the order above is the tie-break, which puts
  // "account created" before anything that happened at the same moment.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => ms(a.event.at) - ms(b.event.at) || a.index - b.index)
    .map(({ event }) => event);
}
