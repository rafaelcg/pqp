package gg.pqp.app.bau.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.media3.common.C
import androidx.media3.common.Player
import gg.pqp.app.PqpApplication
import gg.pqp.app.R
import gg.pqp.app.bau.BauCaptionTrack
import gg.pqp.app.bau.BauCaptions
import gg.pqp.app.bau.BauCaptionsPreference
import gg.pqp.app.bau.BauCaptionsSource
import gg.pqp.app.bau.CaptionCue
import gg.pqp.app.bau.bauCaptions
import gg.pqp.app.core.runSuspendCatching
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * What the player draws for a post's automatic subtitles: whether there are any for the file that is playing,
 * whether they are on, the line to show now, and the language to name. Null from [rememberBauCaptions] when
 * the post has none.
 */
@Stable
internal class BauCaptionsState(
    /** Subtitles exist and fit the file that is playing: the CC button is drawn. */
    val available: Boolean,
    val on: Boolean,
    /** The cue to draw right now; empty between cues, and while off. */
    val cue: String,
    /** "Português (automática)", or "Áudio original" when the track's language has no name. */
    val label: String?,
    val toggle: () -> Unit,
    /** The read of the subtitles failed: the button is drawn anyway and a press asks again. */
    val failed: Boolean = false,
    val retry: () -> Unit = {},
)

/**
 * The subtitles of [source] over [player] (`VideoPlayer` in `community-home-media.tsx`, drawn by us rather than by
 * ExoPlayer's text renderer: the WebVTT is parsed here and the cue for the playing position is shown over the video,
 * which keeps the CC button instant, works in the full screen the same as inline, and needs no re-prepare of the
 * stream to switch a track).
 *
 * Fetched the first time the card is the one playing, not for every video in the feed. A failed read leaves the
 * player as it always was; the next CC press asks again.
 */
@Composable
internal fun rememberBauCaptions(player: Player?, source: BauCaptionsSource?): BauCaptionsState? {
    if (player == null || source == null) return null
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val readerTag = locale.toLanguageTag()
    val session = (context.applicationContext as? PqpApplication)?.session

    var tracks by remember(source) { mutableStateOf<List<BauCaptionTrack>>(emptyList()) }
    var attempt by remember(source) { mutableStateOf(0) }
    var failed by remember(source) { mutableStateOf(false) }
    LaunchedEffect(source, readerTag, attempt) {
        if (session == null) return@LaunchedEffect
        runSuspendCatching { session.api.bauCaptions(source.serverId, source.postId, BauCaptions.requestLang(readerTag)) }
            .onSuccess {
                tracks = it
                failed = false
            }
            .onFailure { failed = true }
    }

    // null until the reader presses CC: the default can only be worked out once the subtitles are known to fit.
    var choice by remember(source) { mutableStateOf<Boolean?>(null) }
    val on = choice ?: BauCaptions.onByDefault(source.sourceLang, readerTag, BauCaptionsPreference.read(context))

    var durationMs by remember(player) { mutableStateOf(player.duration.takeIf { it != C.TIME_UNSET }) }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                durationMs = player.duration.takeIf { it != C.TIME_UNSET }
            }

            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                durationMs = player.duration.takeIf { it != C.TIME_UNSET }
            }
        }
        player.addListener(listener)
        onDispose { player.removeListener(listener) }
    }

    val fits = BauCaptions.fits(source, durationMs)
    val track = remember(tracks, readerTag) { BauCaptions.pickTrack(tracks, readerTag) }
    val cues: List<CaptionCue> = remember(track) { track?.let { BauCaptions.parseVtt(it.vtt) }.orEmpty() }
    val available = fits && cues.isNotEmpty()

    var cue by remember(track) { mutableStateOf("") }
    LaunchedEffect(cues, on, available, player) {
        if (!on || !available) {
            cue = ""
            return@LaunchedEffect
        }
        while (isActive) {
            cue = BauCaptions.cueAt(cues, player.currentPosition)
            delay(CUE_POLL_MS)
        }
    }

    val unknown = stringResource(R.string.bau_captions_unknown)
    val label = track?.let {
        BauCaptions.languageName(it.lang, locale)?.let { name -> stringResource(R.string.bau_captions_auto, name) } ?: unknown
    }
    return BauCaptionsState(
        available = available,
        on = on,
        cue = cue,
        label = label,
        toggle = {
            val next = !on
            BauCaptionsPreference.write(context, next)
            choice = next
        },
        // A blip must not cost the subtitles for as long as the card stays: with nothing read, the button is
        // still there and a press asks again (it does not change the remembered on/off choice).
        failed = failed && !available,
        retry = { attempt += 1 },
    )
}

private const val CUE_POLL_MS = 120L

/** The CC button, and the language it is showing while on. */
@Composable
internal fun BauCaptionsButton(state: BauCaptionsState, modifier: Modifier = Modifier) {
    if (!state.available && !state.failed) return
    val description = stringResource(if (state.on) R.string.bau_captions_off else R.string.bau_captions_on)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.padding(Spacing.xs),
    ) {
        if (state.on) {
            state.label?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.labelSmall,
                    color = Color.White,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(Color.Black.copy(alpha = 0.55f))
                        .padding(horizontal = Spacing.sm, vertical = 2.dp)
                        .testTag("bau.captions.label"),
                )
            }
        }
        IconButton(
            onClick = if (state.failed) state.retry else state.toggle,
            modifier = Modifier
                .size(40.dp)
                .semantics { contentDescription = description }
                .testTag("bau.captions.toggle"),
        ) {
            Icon(
                imageVector = PqpIcons.Captions,
                contentDescription = null,
                tint = if (state.on) MaterialTheme.colorScheme.primary else Color.White,
                modifier = Modifier.background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(6.dp)),
            )
        }
    }
}

/** The current cue, over the bottom of the video and above the controller. */
@Composable
internal fun BauCaptionsCue(state: BauCaptionsState, bottomPadding: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    if (!state.on || state.cue.isEmpty()) return
    Box(modifier = modifier.padding(horizontal = Spacing.lg).padding(bottom = bottomPadding)) {
        Text(
            text = state.cue,
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(Color.Black.copy(alpha = 0.7f))
                .padding(horizontal = Spacing.sm, vertical = 2.dp)
                .testTag("bau.captions.cue"),
        )
    }
}
