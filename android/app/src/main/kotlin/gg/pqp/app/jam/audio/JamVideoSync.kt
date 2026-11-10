package gg.pqp.app.jam.audio

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import gg.pqp.app.core.Backend
import gg.pqp.app.jam.JamTrack
import kotlin.math.abs

/**
 * What a video should be doing at a song position, and how far it may stray.
 * Pure, so the rules are a test (`JamVideoPlanTest`) and not a feeling.
 */
object JamVideoPlan {
    /** Drift under this is not worth touching. */
    const val TOLERANCE_MS = 45.0

    /** Drift under this is corrected by a gentle speed change; past it, by a seek. */
    const val NUDGE_LIMIT_MS = 350.0

    /** The speed change: 4 percent is invisible and catches 40 ms in a second. */
    const val NUDGE = 0.04f

    sealed interface Correction {
        data object None : Correction

        /** Run at [speed] until the next check. */
        data class Speed(val speed: Float) : Correction

        data class Seek(val toMs: Long) : Correction
    }

    /**
     * [actualMs] is the video's own position, [expectedMs] where the audio says
     * it should be (the file time at the position being HEARD).
     */
    fun correction(actualMs: Double, expectedMs: Double): Correction {
        val drift = actualMs - expectedMs
        return when {
            abs(drift) <= TOLERANCE_MS -> Correction.None
            abs(drift) <= NUDGE_LIMIT_MS -> Correction.Speed(if (drift > 0) 1f - NUDGE else 1f + NUDGE)
            else -> Correction.Seek(expectedMs.toLong().coerceAtLeast(0))
        }
    }

    /** True while the song position has not reached the video's slice yet: it waits on its first frame. */
    fun waiting(songMs: Double, track: JamTrack): Boolean = songMs < track.offsetMs

    /** True once the song position is past the end of the video's slice. */
    fun finished(songMs: Double, track: JamTrack): Boolean = songMs >= track.endMs
}

/**
 * The video stems, muted, locked to the audio clock.
 *
 * THE AUDIO IS THE CLOCK. A video here never plays its own sound (its audio
 * track is switched off, so there is no decoder and no audio focus: the sound
 * is the same take's stem, already in the mixer) and is never the thing the
 * others follow. Every few hundred milliseconds [sync] compares it with the
 * position being heard; a small drift is eased out by a 4 percent speed change,
 * a large one by a seek. Before its slice starts a video waits on its first
 * frame; after it ends it holds the last.
 *
 * The file time shown at song time `s` is `s - offsetMs + trimStartMs`
 * (`JamAlignment.videoFileMs`): the same slice arithmetic as the audio, because
 * a take recorded with a camera is cut so its sample 0 is the video's first
 * frame, and one `offsetMs` places both.
 *
 * Main thread only. At most [MAX_PLAYERS] exist, so a song with nine videos
 * decodes four.
 */
@OptIn(UnstableApi::class)
class JamVideoStage(private val context: Context) {
    class Item(val track: JamTrack, val player: ExoPlayer)

    private val items = LinkedHashMap<String, Item>()
    private var speeds = HashMap<String, Float>()

    val tracks: List<JamTrack> get() = items.values.map { it.track }

    fun player(trackId: String): ExoPlayer? = items[trackId]?.player

    /** Make these the videos on screen: players are kept for tracks that stay, created and released for the rest. */
    fun load(wanted: List<JamTrack>) {
        val chosen = wanted.filter { it.hasVideo }.take(MAX_PLAYERS)
        val ids = chosen.mapTo(HashSet()) { it.id }
        items.keys.filter { it !in ids }.forEach { id ->
            items.remove(id)?.player?.release()
            speeds.remove(id)
        }
        for (track in chosen) {
            val existing = items[track.id]
            if (existing != null) {
                // Same file, maybe a moved offset: keep the player, take the new numbers.
                items[track.id] = Item(track, existing.player)
                continue
            }
            val url = Backend.absolute(track.videoUrl) ?: continue
            val player = ExoPlayer.Builder(context).build().apply {
                // No sound, no decoder, no focus: this is the picture only.
                trackSelectionParameters = trackSelectionParameters.buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
                    .build()
                volume = 0f
                setSeekParameters(SeekParameters.EXACT)
                repeatMode = androidx.media3.common.Player.REPEAT_MODE_OFF
                setMediaItem(MediaItem.fromUri(Uri.parse(url)))
                playWhenReady = false
                prepare()
            }
            items[track.id] = Item(track, player)
        }
    }

    private fun fileMs(item: Item, songMs: Double): Double =
        JamAlignment.videoFileMs(
            songMs, item.track.offsetMs, item.track.trimStartMs, item.track.trimEndMs, item.track.durationMs,
        )

    /** Show the frame for a song position without playing. */
    fun park(songMs: Double) {
        for (item in items.values) {
            item.player.pause()
            item.player.playbackParameters = PlaybackParameters(1f)
            item.player.seekTo(fileMs(item, songMs).toLong())
        }
    }

    /** Called while playing, every few hundred ms, with the position being heard. */
    fun sync(songMs: Double) {
        for ((id, item) in items) {
            val player = item.player
            when {
                JamVideoPlan.waiting(songMs, item.track) -> {
                    if (player.isPlaying) player.pause()
                    if (abs(player.currentPosition - item.track.trimStartMs) > 1) player.seekTo(item.track.trimStartMs.toLong())
                }
                JamVideoPlan.finished(songMs, item.track) -> if (player.isPlaying) player.pause()
                else -> {
                    val expected = fileMs(item, songMs)
                    if (!player.isPlaying) {
                        player.seekTo(expected.toLong())
                        player.play()
                    } else {
                        when (val fix = JamVideoPlan.correction(player.currentPosition.toDouble(), expected)) {
                            JamVideoPlan.Correction.None -> setSpeed(id, player, 1f)
                            is JamVideoPlan.Correction.Speed -> setSpeed(id, player, fix.speed)
                            is JamVideoPlan.Correction.Seek -> {
                                player.seekTo(fix.toMs)
                                setSpeed(id, player, 1f)
                            }
                        }
                    }
                }
            }
        }
    }

    private fun setSpeed(id: String, player: ExoPlayer, speed: Float) {
        if (speeds[id] == speed || (speeds[id] == null && speed == 1f)) return
        speeds[id] = speed
        player.playbackParameters = PlaybackParameters(speed)
    }

    fun pause() {
        for (item in items.values) item.player.pause()
    }

    fun release() {
        items.values.forEach { it.player.release() }
        items.clear()
        speeds.clear()
    }

    companion object {
        const val MAX_PLAYERS = 4
    }
}
