package gg.pqp.app.jam.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import gg.pqp.app.core.Backend
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.onboarding.ui.rememberReduceMotion

/*
 * A SONG'S COVER, on its wall tile and in its header.
 *
 * Every read of a song (the list, the detail, any song frame) carries a freshly
 * SIGNED address for the same picture, and an address expires. So the image is
 * cached under the SONG and the picture's own PATH (`JamSongSummary.coverKey`),
 * never under the URL: re-reading the song, a frame arriving when somebody adds a
 * take, a new signature after twelve hours, none of them reloads or flashes a
 * picture that is already drawn, and a replaced cover is a different path and so
 * a different key. The contract says exactly this ("the key inside it never
 * changes for a given picture", `packages/shared/src/jam.ts`).
 *
 * The art a song has always had (the instrument's colour with the mix's
 * waveform) is what is under the picture: it is what shows while the cover loads,
 * and what stays when it cannot be had (an expired address that has not been
 * refreshed yet, no network), so a tile is never a broken image and never blank.
 */

/** Where a song's cover is: nothing to draw, on its way, drawn, or not to be had. */
enum class JamCoverStatus { None, Loading, Ready, Failed }

/**
 * The picture, filling its parent, and what became of it through [onStatus] so
 * the caller can switch to light text over it (and back if it never arrives).
 * Draws nothing at all for a song with no cover.
 */
@Composable
fun JamCoverImage(song: JamSongSummary, modifier: Modifier = Modifier, onStatus: (JamCoverStatus) -> Unit = {}) {
    val key = song.coverKey
    val url = Backend.absolute(song.coverUrl)
    if (key == null || url == null) {
        androidx.compose.runtime.SideEffect { onStatus(JamCoverStatus.None) }
        return
    }
    val reduce = rememberReduceMotion()
    val context = LocalContext.current
    var status by remember(key) { mutableStateOf(JamCoverStatus.Loading) }
    // The request is rebuilt when the signature changes (so a failed, expired one is retried with the fresh one) and
    // is cached under [key] in memory and on disk whichever signature fetched it.
    val request = remember(key, url, reduce) {
        ImageRequest.Builder(context)
            .data(url)
            .memoryCacheKey(key)
            .diskCacheKey(key)
            .crossfade(if (reduce) 0 else 300)
            .build()
    }
    AsyncImage(
        model = request,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        onLoading = {
            if (status != JamCoverStatus.Ready) status = JamCoverStatus.Loading
            onStatus(status)
        },
        onSuccess = {
            status = JamCoverStatus.Ready
            onStatus(status)
        },
        onError = {
            // A picture already drawn stays: only one that never arrived is failed.
            if (status != JamCoverStatus.Ready) status = JamCoverStatus.Failed
            onStatus(status)
        },
        modifier = modifier.fillMaxSize(),
    )
}

/** The scrim that keeps light text readable over any picture. */
@Composable
fun JamCoverScrim(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    0f to Color(0x33000000),
                    0.4f to Color.Transparent,
                    0.62f to Color(0x55000000),
                    1f to Color(0xE605080C),
                ),
            ),
    )
}
