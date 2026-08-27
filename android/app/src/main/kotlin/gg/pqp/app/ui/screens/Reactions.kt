package gg.pqp.app.ui.screens

import gg.pqp.app.core.Reaction
import gg.pqp.app.core.ReactionUser

/**
 * The quick set, in the web client's order.
 *
 * Read `QUICK_REACTIONS` in `client/src/lib/emoji-shortcodes.ts`: the same eight,
 * in the same order, so a channel does not have two different vocabularies
 * depending on which client somebody happens to be holding.
 * `ReactionsTest` pins the copy against that file.
 */
val QUICK_REACTIONS: List<String> = listOf("👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀")

/**
 * Fold a `reaction-broadcast` into a message's reactions.
 *
 * **The broadcast is a delta, not a list.** It says "this person added or
 * removed this emoji", and the client is expected to already know the rest.
 * That makes this the one place a reaction count can silently drift: apply an
 * add twice and everybody's screen says two people liked something one person
 * liked, with no refetch anywhere to correct it. The server re-sends the whole
 * list only on the next page load.
 *
 * It follows `applyReactionBroadcast` in `client/src/hooks/use-chat.ts`,
 * including the two guards that are easy to leave out and impossible to notice
 * without them:
 *
 *  - an add for somebody already in `users` does **not** raise the count, so
 *    the same frame arriving twice is idempotent;
 *  - a removal that takes the count to zero drops the pill entirely, rather
 *    than leaving a "0" nobody can tap away.
 *
 * It has one guard the web does not need, at the top: see the comment there.
 * The difference is that this client is optimistic and the web client is not.
 *
 * `me` is what decides whether the pill is drawn as ours, so it is set from the
 * broadcast's `userId` rather than inferred from the count.
 */
fun applyReactionBroadcast(
    reactions: List<Reaction>,
    emoji: String,
    userId: String,
    displayName: String?,
    added: Boolean,
    currentUserId: String?,
): List<Reaction> {
    val existing = reactions.firstOrNull { it.emoji == emoji }
    val isMe = currentUserId != null && userId == currentUserId

    // Our own frame, describing something already on screen.
    //
    // This client is optimistic: the pill moves the instant it is tapped,
    // because a control that waits for a socket round trip reads as dead and
    // gets tapped again. The web client is not (`toggleReaction` in
    // `use-chat.ts` sends and waits), so its reducer is only ever applied once
    // and does not need this line. Here the broadcast lands on top of a change
    // already made, and folding it a second time is wrong in a way that shows:
    // a person taking back their reaction from a message two people liked took
    // the count from 2 to 1 optimistically, and then the echo of their own
    // frame saw `count <= 1` and deleted the pill, hiding somebody else's
    // reaction on that device alone until the next page load.
    //
    // `me` is exactly the boolean the broadcast asserts about us, so agreement
    // means "already applied". Disagreement still applies, which is what keeps
    // a reaction made on another device working.
    if (isMe && (existing?.me ?: false) == added) return reactions

    val users = existing?.users.orEmpty()
    val already = users.any { it.id == userId }
    val reactor = ReactionUser(id = userId, displayName = displayName.orEmpty())

    if (added) {
        if (existing == null) {
            return reactions + Reaction(
                emoji = emoji,
                count = 1,
                me = isMe,
                users = listOf(reactor),
            )
        }
        return reactions.map { reaction ->
            if (reaction.emoji != emoji) {
                reaction
            } else {
                reaction.copy(
                    count = if (already) reaction.count else reaction.count + 1,
                    me = reaction.me || isMe,
                    users = if (already) users else users + reactor,
                )
            }
        }
    }

    if (existing == null) return reactions
    if (existing.count <= 1) return reactions.filterNot { it.emoji == emoji }

    return reactions.map { reaction ->
        if (reaction.emoji != emoji) {
            reaction
        } else {
            reaction.copy(
                count = reaction.count - 1,
                me = if (isMe) false else reaction.me,
                users = users.filterNot { it.id == userId },
            )
        }
    }
}

/**
 * What the pill should look like the instant it is tapped, before the server
 * has said anything.
 *
 * A reaction is a round trip over a socket that may be reconnecting, and a pill
 * that does not move until the broadcast comes back reads as a dead control:
 * people tap it again, which sends a second toggle and undoes the first. So the
 * change is applied locally and the broadcast, when it lands, is idempotent
 * against it (see [applyReactionBroadcast]).
 *
 * This is the local user's own toggle, so `me` is what it flips on.
 */
fun toggleOwnReaction(
    reactions: List<Reaction>,
    emoji: String,
    currentUserId: String?,
    displayName: String?,
): List<Reaction> {
    val existing = reactions.firstOrNull { it.emoji == emoji }
    val adding = existing == null || !existing.me
    return applyReactionBroadcast(
        reactions = reactions,
        emoji = emoji,
        userId = currentUserId ?: return reactions,
        displayName = displayName,
        added = adding,
        currentUserId = currentUserId,
    )
}
