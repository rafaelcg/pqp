package gg.pqp.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.push.DeepLinkTarget
import gg.pqp.app.push.PushController
import gg.pqp.app.social.ui.HomeScreen
import gg.pqp.app.social.ui.conversationDestination
import gg.pqp.app.ui.components.CallBar
import gg.pqp.app.ui.screens.AgeGateScreen
import gg.pqp.app.ui.screens.ChannelsScreen
import gg.pqp.app.ui.screens.ChatScreen
import gg.pqp.app.ui.screens.FailedScreen
import gg.pqp.app.ui.screens.SignInScreen
import gg.pqp.app.ui.screens.YouScreen
import gg.pqp.app.voice.VoiceController
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.serialization.Serializable

@Serializable object ServersRoute

@Serializable data class ChannelsRoute(val serverId: String, val serverName: String)

/**
 * `channelName` defaults because a notification tap knows the channel's id and
 * not its name: the push payload carries ids and a rendered sentence, never a
 * channel record. The name is filled in when it is cheap to look up and left
 * blank when it is not, which `ChatScreen` renders as a placeholder rather than
 * as `#`.
 */
@Serializable data class ChatRoute(val channelId: String, val channelName: String = "")

@Serializable object YouRoute

@Composable
fun PqpApp(session: SessionStore, voice: VoiceController, push: PushController) {
    val phase by session.phase.collectAsStateWithLifecycle()

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        AnimatedContent(
            targetState = phaseKey(phase),
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "session-phase",
        ) { key ->
            when (key) {
                PhaseKey.Launching -> Box(Modifier.fillMaxSize())
                PhaseKey.SignedOut -> SignInScreen(session)
                PhaseKey.AgeGate -> AgeGateScreen(session)
                PhaseKey.Failed -> FailedScreen(
                    reason = (phase as? SessionPhase.Failed)?.reason.orEmpty(),
                    onRetry = session::restore,
                )
                PhaseKey.Blocked -> FailedScreen(
                    reason = (phase as? SessionPhase.Blocked)?.reason.orEmpty(),
                    onRetry = null,
                )
                PhaseKey.Ready -> SignedInNav(session, voice, push)
            }
        }
    }
}

/**
 * `AnimatedContent` keys on equality, and `SessionPhase.Ready` carries the
 * account. Without this projection every profile refresh would be a new target
 * state and cross-fade the whole app.
 */
private enum class PhaseKey { Launching, SignedOut, AgeGate, Ready, Failed, Blocked }

private fun phaseKey(phase: SessionPhase): PhaseKey = when (phase) {
    is SessionPhase.Launching -> PhaseKey.Launching
    is SessionPhase.SignedOut -> PhaseKey.SignedOut
    is SessionPhase.AgeGate -> PhaseKey.AgeGate
    is SessionPhase.Ready -> PhaseKey.Ready
    is SessionPhase.Failed -> PhaseKey.Failed
    is SessionPhase.Blocked -> PhaseKey.Blocked
}

@Composable
private fun SignedInNav(session: SessionStore, voice: VoiceController, push: PushController) {
    val nav = rememberNavController()
    val voiceState by voice.state.collectAsStateWithLifecycle()

    // A tapped notification, routed only once the app is signed in and has a
    // NavController. Anything tapped earlier waited on the controller.
    //
    // KEYED ON `Unit`, NOT ON THE TARGET, and that is not a style choice. Keyed
    // on the target, `consumeTarget()` changes the key mid-effect and cancels
    // the coroutine that is still resolving the channel's name, and because
    // `runCatching` catches `CancellationException` like any other throwable,
    // the cancellation is swallowed and the navigation completes with an empty
    // name instead of failing. That produced a chat screen titled
    // "Conversation" for a channel called #general, which is the kind of bug
    // that looks like a missing lookup and is actually a cancelled one.
    LaunchedEffect(Unit) {
        push.pendingTarget.filterNotNull().collect { target ->
            push.consumeTarget()
            navigateToPush(nav, session, target)
        }
    }

    Column(Modifier.fillMaxSize()) {
        // The call bar belongs to the process, not to the screen that started
        // the call, so it lives above the NavHost rather than inside any one
        // destination. It carries the status-bar inset itself while it is
        // showing, and the content below then stops adding that inset a second
        // time.
        CallBar(voiceState, voice, Modifier.statusBarsPadding())

        Box(
            modifier = Modifier
                .weight(1f)
                .then(
                    if (voiceState.isActive) {
                        Modifier.consumeWindowInsets(WindowInsets.statusBars)
                    } else {
                        Modifier
                    },
                ),
        ) {
            // Default transitions are left alone deliberately: Navigation
            // Compose's are the platform's, they cooperate with the predictive
            // back gesture the manifest opts into, and a bespoke slide would
            // break that cooperation.
            NavHost(navController = nav, startDestination = ServersRoute) {
                composable<ServersRoute> {
                    // The start destination is the three-tab home (servers,
                    // messages, friends) rather than the server list alone.
                    // The route keeps its name so nothing else that addresses
                    // it has to change.
                    HomeScreen(
                        session = session,
                        onOpenServer = { server ->
                            nav.navigate(ChannelsRoute(server.id, server.name))
                        },
                        onOpenConversation = { route -> nav.navigate(route) },
                        onOpenProfile = { nav.navigate(YouRoute) },
                    )
                }
                conversationDestination(session, onBack = nav::popBackStack)
                composable<ChannelsRoute> { entry ->
                    val route = entry.toRoute<ChannelsRoute>()
                    ChannelsScreen(
                        session = session,
                        voice = voice,
                        serverId = route.serverId,
                        serverName = route.serverName,
                        onBack = nav::popBackStack,
                        onOpenChannel = { channel ->
                            nav.navigate(ChatRoute(channel.id, channel.name))
                        },
                    )
                }
                composable<ChatRoute> { entry ->
                    val route = entry.toRoute<ChatRoute>()
                    ChatScreen(
                        session = session,
                        channelId = route.channelId,
                        channelName = route.channelName,
                        onBack = nav::popBackStack,
                    )
                }
                composable<YouRoute> {
                    YouScreen(session = session, onBack = nav::popBackStack)
                }
            }
        }
    }
}

/**
 * Land a notification tap on the thing it is about.
 *
 * THE ROUTE COMES OUT OF THE PUSH, NOT OUT OF APP STATE. `DeepLink.target`
 * parsed `/app/server/<sid>/channel/<cid>` into both ids without consulting
 * anything the app happens to have loaded, which is what makes a tap on a
 * notification from a server this session has never opened land correctly.
 * Names are the only thing looked up, they are cosmetic, and a miss leaves a
 * placeholder rather than a dead end.
 *
 * A server target opens the channel list; a channel target pushes the chat on
 * top of it, so back goes where a person expects rather than to the server
 * list. An invite has nowhere to go on this client yet.
 */
private suspend fun navigateToPush(
    nav: androidx.navigation.NavHostController,
    session: SessionStore,
    target: DeepLinkTarget,
) {
    fun serverName(id: String): String =
        session.servers.value.firstOrNull { it.id == id }?.name.orEmpty()

    when (target) {
        is DeepLinkTarget.Channel -> {
            nav.navigate(ChannelsRoute(target.serverId, serverName(target.serverId)))
            val name = runCatching { session.api.channels(target.serverId) }
                .getOrNull()
                ?.firstOrNull { it.id == target.channelId }
                ?.name
                .orEmpty()
            nav.navigate(ChatRoute(target.channelId, name))
        }

        is DeepLinkTarget.Server ->
            nav.navigate(ChannelsRoute(target.serverId, serverName(target.serverId)))

        // A conversation id IS a channel id, so the transcript opens with the
        // machinery that is already here. There is no DM list on this client
        // yet to put behind it, which is the one thing this path is missing.
        is DeepLinkTarget.Conversation ->
            nav.navigate(ChatRoute(target.channelId))

        // Redeeming one needs a screen this client does not have. Dropped
        // rather than half-handled: a tap that lands nowhere is better than one
        // that lands somewhere wrong.
        is DeepLinkTarget.Invite -> Unit
    }
}
