package gg.pqp.app.social.ui

import androidx.compose.runtime.DisposableEffect
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.DmSummary
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.ui.screens.ChatScreen
import kotlinx.serialization.Serializable

/**
 * A conversation, as a destination.
 *
 * The title travels in the route rather than being looked up on arrival,
 * because a conversation has no name of its own: it is the participants, the
 * caller already has them, and re-deriving it here would need the list to have
 * loaded before the screen could draw its own app bar.
 */
@Serializable
data class ConversationRoute(val channelId: String, val title: String)

/**
 * The conversation destination, as one call for the app's `NavHost` to make.
 *
 * Packaged this way on purpose: the navigation graph is a file several branches
 * are editing at once, and a feature that adds one line to it is a feature that
 * does not have to be merged by hand.
 */
fun NavGraphBuilder.conversationDestination(
    session: SessionStore,
    onBack: () -> Unit,
) {
    composable<ConversationRoute> { entry ->
        val route = entry.toRoute<ConversationRoute>()
        val social = SocialRepository.of(session)

        // Read on the way in and again on the way out. On the way in because
        // the badge must not survive the reader opening the thing it points at;
        // on the way out because the server sends this socket no
        // `channel-activity` while it is the one viewing the channel, so
        // anything that arrived during the visit would otherwise come back as
        // unread the next time the list is read.
        DisposableEffect(route.channelId) {
            social.markRead(route.channelId)
            onDispose { social.markRead(route.channelId) }
        }

        ChatScreen(
            session = session,
            channelId = route.channelId,
            channelName = route.title,
            onBack = onBack,
            // A conversation's app bar is a person's name, not `#name`: there is
            // no channel here to prefix.
            title = route.title,
        )
    }
}

/** The route for a conversation the caller already holds a summary of. */
fun DmSummary.route(title: String): ConversationRoute = ConversationRoute(channelId, title)
