package gg.pqp.app.bots

import androidx.annotation.StringRes
import gg.pqp.app.R
import gg.pqp.app.core.Message
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Server bots on the phone, native v1: the BOT and BETA tags, the limit notice
 * a member gets when a bot did not answer them, and the "working" text a bot
 * shows in place of "is typing". Cards and the animated face come later.
 *
 * The contract is `botNoticeSchema` in `packages/shared/src/bots.ts` and
 * `activity` on `typing-broadcast` in `packages/shared/src/chat.ts`. The words
 * are the web's (`chat.botNotice.*`, `chat.botActivity.*`).
 *
 * Pure Kotlin on purpose: no `android.net.Uri`, which is a stub in a JVM unit
 * test, and nothing that needs a Context.
 */
object ServerBots {

    /**
     * A bot has no `isBot` on a message or a member. Its avatar is its Breu
     * face, served at `/api/bot-faces/<color>/<face>.png?v=1`, and no uploaded
     * avatar can have that address. The web reads the same fact in
     * `parseBotFaceAvatar`.
     *
     * Matches the root-relative form and the same URL resolved against an API
     * origin. The SHAPE is matched, not the colour and face lists, so a colour
     * added on the server needs no app update. The marker anywhere else in the
     * string (`/uploads/api/bot-faces/...`, a query value) is not a bot.
     */
    private val FACE = Regex("""^(?:https?://[^/?#]+)?/api/bot-faces/[a-z]+/[a-z]+\.png(?:[?#].*)?$""")

    fun isFaceAvatar(url: String?): Boolean =
        url != null && url.contains("/api/bot-faces/") && FACE.matches(url)

    fun isServerBot(message: Message): Boolean = isFaceAvatar(message.authorAvatarUrl)

    /** A bot that goes quiet without posting (a failed run) keeps its row this long. The web waits the same. */
    const val WORK_LIFETIME_MS = 30_000L

    /**
     * A `typing-broadcast` frame's `activity`: null for a person, and for a
     * bot the tool it is running, or null inside while it is thinking. Lenient
     * on purpose: anything that is not an object is not a bot's row.
     */
    fun activityOf(frame: JsonObject): BotActivity? {
        val activity = frame["activity"] as? JsonObject ?: return null
        return BotActivity(tool = (activity["tool"] as? JsonPrimitive)?.contentOrNull)
    }

    /**
     * The sentence for what a bot is doing. [tool] null is "Thinking…";
     * a tool this build does not know reads as "is working".
     */
    @StringRes
    fun activityRes(tool: String?): Int = when (tool) {
        null -> R.string.bot_activity_thinking
        "list_channels" -> R.string.bot_activity_list_channels
        "list_members" -> R.string.bot_activity_list_members
        "create_channel" -> R.string.bot_activity_create_channel
        "edit_channel" -> R.string.bot_activity_edit_channel
        "move_channel" -> R.string.bot_activity_move_channel
        "delete_channel" -> R.string.bot_activity_delete_channel
        "post_message" -> R.string.bot_activity_post_message
        "pin_message" -> R.string.bot_activity_pin_message
        "create_thread" -> R.string.bot_activity_create_thread
        "create_forum_post" -> R.string.bot_activity_create_forum_post
        "create_bau_post" -> R.string.bot_activity_create_bau_post
        "delete_message" -> R.string.bot_activity_delete_message
        "timeout_member" -> R.string.bot_activity_timeout_member
        "kick_member" -> R.string.bot_activity_kick_member
        "ban_member" -> R.string.bot_activity_ban_member
        "read_channel" -> R.string.bot_activity_read_channel
        "list_bans" -> R.string.bot_activity_list_bans
        "create_invite" -> R.string.bot_activity_create_invite
        "remove_timeout" -> R.string.bot_activity_remove_timeout
        "unban_member" -> R.string.bot_activity_unban_member
        "ask_member" -> R.string.bot_activity_ask_member
        "list_forum_posts" -> R.string.bot_activity_list_forum_posts
        "reply_forum_post" -> R.string.bot_activity_reply_forum_post
        "create_poll" -> R.string.bot_activity_create_poll
        "read_poll" -> R.string.bot_activity_read_poll
        "vote_poll" -> R.string.bot_activity_vote_poll
        else -> R.string.bot_activity_working
    }
}

/** What a bot's typing frame says it is doing. [tool] is null while it thinks. */
data class BotActivity(val tool: String?)

/** A server bot at work in the channel on screen. */
data class BotWork(
    val userId: String,
    val name: String,
    val tool: String?,
)

/** Why a bot did not answer. [wire] is the frame's `reason`. */
enum class BotNoticeReason(val wire: String) {
    Busy("busy"),
    MemberHour("member-hour"),
    ServerDay("server-day"),
    Budget("budget");

    companion object {
        fun fromWire(token: String?): BotNoticeReason? = entries.firstOrNull { it.wire == token }
    }
}

/**
 * A `bot-notice` frame: sent only to the member the bot did not answer, on
 * their own sockets. Nothing is posted in the channel.
 */
data class BotNotice(
    val channelId: String,
    val botUserId: String,
    val botName: String,
    val reason: BotNoticeReason,
    /** The limit reached, for [BotNoticeReason.MemberHour] and [BotNoticeReason.ServerDay]. */
    val limit: Int?,
    /** When the bot answers again, in epoch milliseconds, if the server said. */
    val retryAtMs: Long?,
) {
    /** True once the bot is due to answer again, so the notice is no longer true. */
    fun isExpired(nowMs: Long): Boolean = retryAtMs != null && retryAtMs <= nowMs

    /** The string for this reason; the `Until` form is used only when a time is known. */
    @StringRes
    fun textRes(): Int {
        val known = retryAtMs != null
        return when (reason) {
            BotNoticeReason.Busy -> R.string.bot_notice_busy
            BotNoticeReason.MemberHour ->
                if (known) R.string.bot_notice_member_hour_until else R.string.bot_notice_member_hour
            BotNoticeReason.ServerDay ->
                if (known) R.string.bot_notice_server_day_until else R.string.bot_notice_server_day
            BotNoticeReason.Budget ->
                if (known) R.string.bot_notice_budget_until else R.string.bot_notice_budget
        }
    }

    companion object {
        /**
         * Reads a frame. A missing field, or a reason this build has never
         * heard of, drops the frame instead of guessing at it. `null` inside
         * the frame (`limit`, `retryAt`) is the ordinary case.
         */
        fun parse(frame: JsonObject): BotNotice? {
            fun str(key: String) = (frame[key] as? JsonPrimitive)?.contentOrNull
            val channelId = str("channelId") ?: return null
            val botUserId = str("botUserId") ?: return null
            val reason = BotNoticeReason.fromWire(str("reason")) ?: return null
            return BotNotice(
                channelId = channelId,
                botUserId = botUserId,
                botName = str("botName")?.takeIf { it.isNotEmpty() } ?: "Bot",
                reason = reason,
                limit = (frame["limit"] as? JsonPrimitive)?.intOrNull,
                retryAtMs = str("retryAt")?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() },
            )
        }
    }
}
