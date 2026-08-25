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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.ui.components.CallBar
import gg.pqp.app.ui.screens.AgeGateScreen
import gg.pqp.app.ui.screens.ChannelsScreen
import gg.pqp.app.ui.screens.ChatScreen
import gg.pqp.app.ui.screens.FailedScreen
import gg.pqp.app.ui.screens.ServersScreen
import gg.pqp.app.ui.screens.SignInScreen
import gg.pqp.app.ui.screens.YouScreen
import gg.pqp.app.voice.VoiceController
import kotlinx.serialization.Serializable

@Serializable object ServersRoute

@Serializable data class ChannelsRoute(val serverId: String, val serverName: String)

@Serializable data class ChatRoute(val channelId: String, val channelName: String)

@Serializable object YouRoute

@Composable
fun PqpApp(session: SessionStore, voice: VoiceController) {
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
                PhaseKey.Ready -> SignedInNav(session, voice)
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
private fun SignedInNav(session: SessionStore, voice: VoiceController) {
    val nav = rememberNavController()
    val voiceState by voice.state.collectAsStateWithLifecycle()

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
                    ServersScreen(
                        session = session,
                        onOpenServer = { server ->
                            nav.navigate(ChannelsRoute(server.id, server.name))
                        },
                        onOpenProfile = { nav.navigate(YouRoute) },
                    )
                }
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
