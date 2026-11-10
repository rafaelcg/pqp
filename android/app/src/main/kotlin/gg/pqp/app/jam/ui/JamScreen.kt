package gg.pqp.app.jam.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.pqp.app.PqpApplication
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.jam.JamSeenStore
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamSongViewModel
import gg.pqp.app.jam.JamWallViewModel

/**
 * A jam channel: the wall, and a song opened out of it.
 *
 * The song is state of this screen rather than a route of its own, for two
 * reasons. A tile that GROWS into the song is a shared element, and that needs
 * both ends under one `SharedTransitionLayout`, which a back stack of separate
 * destinations does not give without wrapping the whole app's NavHost in one.
 * And the wall (its pages, its scroll position, the previews it already read)
 * stays alive underneath, so back lands exactly where the person was. Back
 * closes the song first, then leaves the channel.
 *
 * The wall's view model owns the channel's slot on the socket for as long as
 * this screen is up; the song's only listens.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun JamScreen(
    session: SessionStore,
    serverId: String,
    serverName: String,
    channelId: String,
    channelName: String,
    /** A song link or a push opens straight onto this song. */
    initialSongId: String?,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val seen = remember(context) { JamSeenStore(context) }
    val wall: JamWallViewModel = viewModel(
        key = "jam-wall:$channelId",
        factory = JamWallViewModel.factory(session, seen, serverId, channelId),
    )
    val phase by session.phase.collectAsStateWithLifecycle()
    val viewerId = (phase as? SessionPhase.Ready)?.me?.id
    var openSong by rememberSaveable { mutableStateOf(initialSongId) }
    // A new view model per opening: closing a song releases its media, so the same song reopened must not find the husk.
    var openings by rememberSaveable { mutableIntStateOf(0) }
    // The summary the wall already holds, so the song's header is there at once.
    var seeds by remember { mutableStateOf(emptyMap<String, JamSongSummary>()) }

    LifecycleStartEffect(channelId) {
        wall.start()
        onStopOrDispose { wall.stop() }
    }
    BackHandler(enabled = openSong != null) { openSong = null }

    SharedTransitionLayout {
        AnimatedContent(
            targetState = openSong,
            transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(180)) },
            label = "jam-song",
        ) { songId ->
            val shared = JamSharedScope(this@SharedTransitionLayout, this@AnimatedContent)
            if (songId == null) {
                JamWallScreen(
                    model = wall,
                    channelName = channelName,
                    serverName = serverName,
                    shared = shared,
                    onBack = onBack,
                    onOpenSong = { song ->
                        seeds = seeds + (song.id to song)
                        openings += 1
                        openSong = song.id
                    },
                )
            } else {
                val callActive = (context.applicationContext as PqpApplication).callActive
                val model: JamSongViewModel = viewModel(
                    key = "jam-song:$songId:$openings",
                    factory = JamSongViewModel.factory(session, context, callActive, songId, channelId),
                )
                val seed = seeds[songId] ?: wall.state.value.wall.songs.firstOrNull { it.id == songId }
                JamSongScreen(
                    model = model,
                    songId = songId,
                    serverId = serverId,
                    channelId = channelId,
                    seed = seed,
                    shared = shared,
                    viewerId = viewerId,
                    onBack = { openSong = null },
                )
            }
        }
    }
}
