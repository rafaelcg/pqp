package gg.pqp.app.watch.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.core.SessionStore
import gg.pqp.app.watch.ChannelLive
import gg.pqp.app.watch.WatchLiveStore
import gg.pqp.app.watch.resolve

/**
 * The mount: when the picture is on screen, and who the server thinks is
 * looking at it.
 *
 * Split from [WatchPane] because those are two jobs and only one of them talks
 * to the socket. This one announces `watch-live true` for as long as a voice
 * room's channel is open on this phone, and takes it back when the screen goes.
 * [WatchLiveStore] makes both idempotent, so a recomposition is not a second
 * viewer and a double retraction is not a negative one.
 *
 * **The announcement is not conditional on a stream existing.** Somebody who
 * opened the channel to wait for the show is part of the audience the host is
 * watching the number of, and the server already knows what to do with a
 * watcher on a channel that is not transcoding yet: it keeps the count and
 * starts nothing. What it is conditional on is a seat, which the store checks,
 * because a seat is already on the roster.
 *
 * Nothing here joins a call, and nothing here can: see the store for why that
 * is structural rather than a promise.
 */
@Composable
fun WatchChannelPane(
    session: SessionStore,
    store: WatchLiveStore,
    channelId: String,
    modifier: Modifier = Modifier,
) {
    val channels by store.channels.collectAsStateWithLifecycle()
    val live = channels[channelId] ?: ChannelLive.NOTHING

    // The socket pushes a `channel-live` for every live channel this person may
    // see, but only at auth. A channel opened while the socket was down or
    // reconnecting would otherwise show nothing until the next keyframe, which
    // is thirty seconds of a live watch party looking like an empty room.
    LaunchedEffect(channelId) { store.seedFromApi(channelId) }

    DisposableEffect(channelId) {
        store.watch(channelId)
        onDispose { store.unwatch(channelId) }
    }

    WatchPane(
        live = live,
        // The player's own way out of a dead session. A share that stopped and
        // came back has a different `startedAt`, so the URL this pane holds is
        // gone and only the API can say what replaced it.
        refresh = {
            runCatching { session.api.channelLive(channelId).stream?.resolve() }.getOrNull()
        },
        modifier = modifier,
    )
}
