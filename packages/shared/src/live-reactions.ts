import { z } from "zod";

/**
 * TWITCH-STYLE LIVE REACTIONS OVER A SHARED SCREEN.
 *
 * A viewer taps an emoji, it floats up over the video and fades. That is the
 * whole feature, and the shape of the contract follows from two things it is
 * deliberately NOT.
 *
 * IT IS NOT A MESSAGE REACTION. `reaction-toggle` in `chat.ts` writes a row,
 * has a `me` flag, survives a reload and can be removed. None of that is
 * wanted here: a live reaction is a moment, it is never stored, nobody can
 * take one back, and reloading the page correctly loses every one of them.
 * Reusing that path would put a database write behind a control people tap
 * twenty times a minute during a match.
 *
 * IT IS NOT PER PERSON. What travels back is a COUNT PER EMOJI over a window,
 * never a list of who tapped what. The overlay draws particles; a particle has
 * no author. Sending the author would cost a name and an avatar url per tap
 * for something the UI throws away, and it would turn an anonymous cheer into
 * an attributable one, which is a different product.
 *
 * COALESCING IS THE POINT. Two hundred people tapping in a watch party is two
 * hundred frames per burst if each one is relayed. The server folds a channel's
 * taps into one `live-reactions` frame per `LIVE_REACTION_WINDOW_MS`, so the
 * fan-out cost is bounded by the number of ROOMS, not by the number of taps.
 * The client is written to expect that: it spawns `count` particles from one
 * frame rather than one particle per frame.
 *
 * The frames ride the voice signalling socket, for the same reasons the watch
 * party does (`watch-party.ts`): it is already there, already authenticated,
 * already per room, and already transport agnostic across mesh and LiveKit.
 */

/**
 * What may be sent. A closed set, not free text.
 *
 * Overlaps `QUICK_REACTIONS` in `client/src/lib/emoji-shortcodes.ts` on
 * purpose: the same six a person already reaches for on a message are the ones
 * they will reach for over a video, and matching them means the two surfaces do
 * not teach two vocabularies. It is shorter than that list because this is a
 * row of buttons docked over a video, not a picker, and because a sad face over
 * somebody's stream reads as a pile-on rather than a reaction.
 *
 * The set being closed is a moderation property as much as a rendering one:
 * nothing a viewer types reaches another viewer's screen through this path.
 */
export const LIVE_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "🔥",
  "🎉",
] as const;

export type LiveReactionEmoji = (typeof LIVE_REACTION_EMOJIS)[number];

export const liveReactionEmojiSchema = z.enum(LIVE_REACTION_EMOJIS);

/**
 * How long the server holds a channel's taps before it fans them out.
 *
 * 250ms is four frames a second per room, which is under the rate at which the
 * overlay can spawn particles anyway, and short enough that a tap still feels
 * like it answered the thing that just happened on screen.
 */
export const LIVE_REACTION_WINDOW_MS = 250;

/**
 * Taps per second one socket may send before the rest are dropped in silence.
 *
 * Five is faster than a thumb and slower than a script. The drop is silent by
 * design: there is no error frame, because the only client that can exceed this
 * is one that is misbehaving, and telling it so would hand it a reason to
 * retry.
 */
export const LIVE_REACTION_RATE_PER_SECOND = 5;

/**
 * Reactions in one window past which the overlay switches to burst mode.
 *
 * Purely a rendering threshold. The server neither reads it nor sends it; it
 * lives here so web, iOS and Android burst at the same crowd size instead of
 * each picking a number.
 */
export const LIVE_REACTION_BURST_THRESHOLD = 10;

/** Client to server: one tap. */
export const liveReactionMessageSchema = z.object({
  type: z.literal("live-reaction"),
  /**
   * The voice channel the share is in. The server checks it against the room
   * the sender actually holds a peer in rather than trusting it, so this is a
   * statement of intent, not an address.
   */
  channelId: z.string().uuid(),
  emoji: liveReactionEmojiSchema,
});

export type LiveReactionMessage = z.infer<typeof liveReactionMessageSchema>;

export const liveReactionCountSchema = z.object({
  emoji: liveReactionEmojiSchema,
  count: z.number().int().positive(),
});

export type LiveReactionCount = z.infer<typeof liveReactionCountSchema>;

/**
 * Server to room: everything that arrived in one window, as counts.
 *
 * `seq` increments per channel and exists so a client can tell a window it
 * missed from one it is seeing twice. It is not a resend cursor and nothing can
 * be replayed: a missed window is gone, which for confetti is the correct
 * amount of effort to spend on delivery.
 */
export const liveReactionsMessageSchema = z.object({
  type: z.literal("live-reactions"),
  channelId: z.string().uuid(),
  items: z.array(liveReactionCountSchema).min(1),
  seq: z.number().int().nonnegative(),
});

export type LiveReactionsMessage = z.infer<typeof liveReactionsMessageSchema>;

/** Total taps in a window, which is what the burst threshold is compared to. */
export function liveReactionTotal(
  items: readonly LiveReactionCount[],
): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}
