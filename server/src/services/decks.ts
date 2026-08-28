import {
  DEFAULT_DRAW_COUNT,
  MAX_DRAW_COUNT,
  STANDARD_DECK,
  shuffleDeck,
  type ChanceResult,
  type PlayingCard,
  type RandomInt,
} from "@pqp/shared";
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

function asDeck(value: unknown): PlayingCard[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set<string>(STANDARD_DECK);
  return value.filter((card): card is PlayingCard =>
    typeof card === "string" && allowed.has(card),
  );
}

export async function applyChannelDeck(
  client: Queryable,
  channelId: string,
  action: { type: "draw"; count?: number } | { type: "shuffle" },
  randomInt: RandomInt,
): Promise<ChanceResult> {
  const locked = await client.query<{ remaining: unknown }>(
    `SELECT remaining FROM channel_decks WHERE channel_id = $1 FOR UPDATE`,
    [channelId],
  );
  let remaining = asDeck(locked.rows[0]?.remaining);

  if (action.type === "shuffle") {
    remaining = shuffleDeck(randomInt);
    await saveDeck(client, channelId, remaining);
    return { type: "shuffle", remaining: remaining.length };
  }

  const count = action.count ?? DEFAULT_DRAW_COUNT;
  const take = Math.min(MAX_DRAW_COUNT, Math.max(1, count));
  let reshuffled = false;
  if (remaining.length === 0) {
    remaining = shuffleDeck(randomInt);
    reshuffled = true;
  }
  const cards = remaining.slice(0, Math.min(take, remaining.length));
  remaining = remaining.slice(cards.length);
  await saveDeck(client, channelId, remaining);
  return {
    type: "draw",
    cards,
    remaining: remaining.length,
    reshuffled,
  };
}

async function saveDeck(
  client: Queryable,
  channelId: string,
  remaining: PlayingCard[],
): Promise<void> {
  await client.query(
    `INSERT INTO channel_decks (channel_id, remaining)
     VALUES ($1, $2)
     ON CONFLICT (channel_id) DO UPDATE
       SET remaining = EXCLUDED.remaining, updated_at = NOW()`,
    [channelId, JSON.stringify(remaining)],
  );
}
