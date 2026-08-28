import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  isPollClosed,
  type Poll,
  type PollRequest,
} from "@pqp/shared";
import { getPool } from "../db.js";

type Queryable = Pick<PoolClient, "query">;

interface PollRow {
  message_id: string;
  question: string;
  allow_multiselect: boolean;
  closes_at: Date;
  closed_at: Date | null;
  author_id: string;
}

interface OptionRow {
  id: string;
  message_id: string;
  position: number;
  label: string;
  votes: string | number;
  voted: boolean;
}

export async function insertPoll(
  client: Queryable,
  messageId: string,
  request: PollRequest,
): Promise<void> {
  const closesAt = new Date(Date.now() + request.durationSeconds * 1000);
  await client.query(
    `INSERT INTO polls (message_id, question, allow_multiselect, closes_at)
     VALUES ($1, $2, $3, $4)`,
    [messageId, request.question, request.allowMultiselect, closesAt],
  );
  for (const [index, label] of request.options.entries()) {
    await client.query(
      `INSERT INTO poll_options (id, message_id, position, label)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), messageId, index, label],
    );
  }
}

export async function listPollsForMessages(
  messageIds: string[],
  viewerId?: string,
): Promise<Map<string, Poll>> {
  const out = new Map<string, Poll>();
  if (messageIds.length === 0) {
    return out;
  }
  const polls = await getPool().query<PollRow>(
    `SELECT p.message_id, p.question, p.allow_multiselect, p.closes_at, p.closed_at,
            m.author_id
       FROM polls p
       JOIN messages m ON m.id = p.message_id
      WHERE p.message_id = ANY($1::uuid[])`,
    [messageIds],
  );
  if (polls.rows.length === 0) {
    return out;
  }
  const options = await getPool().query<OptionRow>(
    `SELECT o.id, o.message_id, o.position, o.label,
            COUNT(v.user_id)::int AS votes,
            BOOL_OR(v.user_id = $2) AS voted
       FROM poll_options o
       LEFT JOIN poll_votes v ON v.option_id = o.id
      WHERE o.message_id = ANY($1::uuid[])
      GROUP BY o.id, o.message_id, o.position, o.label
      ORDER BY o.position ASC`,
    [messageIds, viewerId ?? "00000000-0000-4000-8000-000000000000"],
  );
  const optionsByMessage = new Map<string, OptionRow[]>();
  for (const option of options.rows) {
    const list = optionsByMessage.get(option.message_id) ?? [];
    list.push(option);
    optionsByMessage.set(option.message_id, list);
  }
  for (const row of polls.rows) {
    const mapped = mapPollRow(row, optionsByMessage.get(row.message_id) ?? [], viewerId);
    out.set(row.message_id, mapped);
  }
  return out;
}

export async function getPoll(
  messageId: string,
  viewerId?: string,
): Promise<Poll | null> {
  const map = await listPollsForMessages([messageId], viewerId);
  return map.get(messageId) ?? null;
}

export interface VoteResult {
  poll: Poll;
  added: boolean;
}

export async function votePoll(
  messageId: string,
  userId: string,
  optionId: string,
): Promise<VoteResult | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const poll = await client.query<PollRow>(
      `SELECT p.message_id, p.question, p.allow_multiselect, p.closes_at, p.closed_at,
              m.author_id
         FROM polls p
         JOIN messages m ON m.id = p.message_id
        WHERE p.message_id = $1
        FOR UPDATE`,
      [messageId],
    );
    const row = poll.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const preview = mapPollRow(row, [], userId);
    if (isPollClosed(preview)) {
      await client.query("ROLLBACK");
      return null;
    }
    const option = await client.query<{ id: string }>(
      `SELECT id FROM poll_options WHERE id = $1 AND message_id = $2`,
      [optionId, messageId],
    );
    if (!option.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const existing = await client.query<{ option_id: string }>(
      `SELECT v.option_id
         FROM poll_votes v
         JOIN poll_options o ON o.id = v.option_id
        WHERE o.message_id = $1 AND v.user_id = $2`,
      [messageId, userId],
    );
    const alreadyOnThis = existing.rows.some((vote) => vote.option_id === optionId);
    if (alreadyOnThis) {
      await client.query(
        `DELETE FROM poll_votes WHERE option_id = $1 AND user_id = $2`,
        [optionId, userId],
      );
    } else {
      if (!row.allow_multiselect && existing.rows.length > 0) {
        await client.query(
          `DELETE FROM poll_votes
            WHERE user_id = $1
              AND option_id IN (SELECT id FROM poll_options WHERE message_id = $2)`,
          [userId, messageId],
        );
      }
      await client.query(
        `INSERT INTO poll_votes (option_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [optionId, userId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const next = await getPoll(messageId, userId);
  if (!next) {
    return null;
  }
  const voted = next.options.find((option) => option.id === optionId)?.voted ?? false;
  return { poll: next, added: voted };
}

export async function closePoll(
  messageId: string,
  userId: string,
  canManage: boolean,
): Promise<Poll | null> {
  const existing = await getPool().query<PollRow>(
    `SELECT p.message_id, p.question, p.allow_multiselect, p.closes_at, p.closed_at,
            m.author_id
       FROM polls p
       JOIN messages m ON m.id = p.message_id
      WHERE p.message_id = $1`,
    [messageId],
  );
  const row = existing.rows[0];
  if (!row) {
    return null;
  }
  if (row.author_id !== userId && !canManage) {
    return null;
  }
  if (row.closed_at) {
    return getPoll(messageId, userId);
  }
  await getPool().query(
    `UPDATE polls SET closed_at = NOW() WHERE message_id = $1 AND closed_at IS NULL`,
    [messageId],
  );
  return getPoll(messageId, userId);
}

function mapPollRow(row: PollRow, options: OptionRow[], viewerId?: string): Poll {
  const mapped = options.map((option) => ({
    id: option.id,
    label: option.label,
    votes: Number(option.votes),
    voted: Boolean(option.voted),
  }));
  const totalVotes = mapped.reduce((sum, option) => sum + option.votes, 0);
  const poll: Poll = {
    question: row.question,
    allowMultiselect: row.allow_multiselect,
    closesAt: row.closes_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    options: mapped,
    totalVotes,
    canClose: !row.closed_at && viewerId === row.author_id,
  };
  if (isPollClosed(poll) && !poll.closedAt) {
    return { ...poll, canClose: false };
  }
  return poll;
}
