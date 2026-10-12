package gg.pqp.app.ui.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.vector.ImageVector
import gg.pqp.app.core.Message
import kotlinx.coroutines.flow.Flow

/** One more entry in a message's long-press sheet, below the built-in ones. */
data class ChatMessageAction(
    val label: String,
    val icon: ImageVector,
    val testTag: String,
    val onClick: () -> Unit,
)

/**
 * Where a transcript opens when it should not open on the newest message.
 *
 * [ready] is false until the caller knows [previousReadAt] (it is the answer
 * of the read that the visit itself moves), and the transcript waits for it
 * rather than drawing at the bottom and jumping. A null [previousReadAt] is a
 * first visit and lands on the oldest message; otherwise the first message
 * from somebody else after it gets the "Novas" divider and the landing.
 */
data class ChatLanding(val ready: Boolean, val previousReadAt: String?)

/**
 * What a surface built on [ChatScreen] adds to it, all in one place so the
 * chat screen stays one screen. Every field defaults to "nothing", and a chat
 * that passes no extras is byte for byte what it was. A forum post is the one
 * caller today (`gg.pqp.app.forum.ui.ForumPostScreen`): a post is a channel,
 * so its transcript, composer, reactions and attachments are this screen's,
 * and what is here is what a post has and a chat does not.
 */
class ChatExtras(
    /** See [ChatViewModel]'s `primaryChannelId`. */
    val primaryChannelId: String? = null,
    /** Replaces the app bar's title. Told whether [transcriptTop] is on screen. */
    val title: (@Composable (topVisible: Boolean) -> Unit)? = null,
    /** Drawn above the oldest message once there is no older history. */
    val transcriptTop: (@Composable () -> Unit)? = null,
    /** Drawn right under the message with this id (a post's question). */
    val belowMessageId: String? = null,
    val belowMessage: (@Composable () -> Unit)? = null,
    /** A short tag after an author's name ("OP"). */
    val authorBadge: (Message) -> String? = { null },
    /** One message drawn with the success edge (the accepted answer). */
    val highlightedMessageId: String? = null,
    /** Extra long-press entries for one message. */
    val messageActions: (Message) -> List<ChatMessageAction> = { emptyList() },
    /** Null keeps the chat's own landing: the newest message. */
    val landing: ChatLanding? = null,
    /** Replaces the whole composer (a locked post, for somebody who may not reply). */
    val composerReplacement: (@Composable () -> Unit)? = null,
    /** A line above the composer (a locked post, for staff). */
    val composerNote: (@Composable () -> Unit)? = null,
    /** The composer's placeholder. */
    val composerHint: String? = null,
    /** Message ids to bring into view ("Ir pra resposta"), paging back if they are not loaded. */
    val scrollRequests: Flow<String>? = null,
    /**
     * Told the oldest message's id once history is complete (null before):
     * a post's question is its first message, and nothing else knows which
     * one that is.
     */
    val onOldest: ((String?) -> Unit)? = null,
    /** The app bar's pinned-messages button. A post has its own pins (the forum's), so it hides this. */
    val showPins: Boolean = true,
)
