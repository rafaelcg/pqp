package gg.pqp.app.soundboard

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
import androidx.annotation.RawRes
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.runSuspendCatching
import gg.pqp.app.social.getJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * A server soundboard (`packages/shared/src/soundboard.ts`, `docs/SOUNDBOARD.md`).
 *
 * THE CLIP NEVER ENTERS THE CALL. A seated member sends `soundboard-play`; the server checks the seat and fans
 * the same frame out to the room, and every client plays a file it already has, locally. Nothing is published,
 * so a phone needs no media negotiation to take part: it hears by playing the clip on its own speaker, and it
 * plays by sending the frame.
 */
data class BuiltinSound(
    /** The wire id (`builtin:palmas`). */
    val id: String,
    /** The clip's own glyph: it is the clip's identity on the wire (`emoji`), not decoration. */
    val emoji: String,
    @RawRes val raw: Int,
    val durationMs: Long,
    /** The name the tile and a screen reader use. */
    val label: Int,
)

object SoundboardBuiltins {
    /** `SOUNDBOARD_BUILTINS`, in the order the board draws them. Pinned to the shared list by a test. */
    val ALL = listOf(
        BuiltinSound("builtin:palmas", "👏", R.raw.palmas, 4400, R.string.soundboard_builtin_palmas),
        BuiltinSound("builtin:risada", "😄", R.raw.risada, 2200, R.string.soundboard_builtin_risada),
        BuiltinSound("builtin:buzina", "📣", R.raw.buzina, 3100, R.string.soundboard_builtin_buzina),
        BuiltinSound("builtin:grilo", "🦗", R.raw.grilo, 2408, R.string.soundboard_builtin_grilo),
        BuiltinSound("builtin:ba-dum-tss", "🥁", R.raw.ba_dum_tss, 3100, R.string.soundboard_builtin_badumtss),
        BuiltinSound("builtin:trombone", "🎺", R.raw.trombone, 4600, R.string.soundboard_builtin_trombone),
    )

    fun byId(id: String): BuiltinSound? = ALL.firstOrNull { it.id == id }
}

/** `soundboardSoundSchema`: a custom clip. [url] is a presigned read, null when storage could not sign one. */
@Serializable
data class CustomSound(
    val id: String,
    val name: String = "",
    val emoji: String = "",
    val contentType: String = "",
    val durationMs: Long = 0,
    val volume: Double = 1.0,
    val url: String? = null,
)

/** `GET /api/servers/:id/soundboard`. */
@Serializable
data class SoundboardPage(
    val sounds: List<CustomSound> = emptyList(),
    val maxSounds: Int = 0,
    val slotsUsed: Int = 0,
)

/** `GET /api/voice/config?serverId=`: what the board needs of it. Defaulted so an older server reads as off. */
@Serializable
data class VoiceConfig(val soundboard: Boolean = false)

suspend fun ApiClient.voiceConfig(serverId: String): VoiceConfig =
    getJson("/api/voice/config", mapOf("serverId" to serverId))

suspend fun ApiClient.soundboard(serverId: String): SoundboardPage =
    getJson("/api/servers/$serverId/soundboard")

/**
 * The server's own play budget, kept in front of the socket (`SOUNDBOARD_PLAY_BURST` and
 * `SOUNDBOARD_PLAY_REFILL_MS`): a burst of five, then one every two seconds. The server refuses the rest in
 * silence, so a click it would refuse is not sent and the person is told at once. Same arithmetic as the web's
 * `takeSendToken`.
 */
class PlayBudget(
    private val burst: Int = BURST,
    private val refillMs: Long = REFILL_MS,
) {
    private var tokens = burst
    private var refilledAt = 0L

    @Synchronized
    fun take(now: Long): Boolean {
        val earned = ((now - refilledAt) / refillMs).toInt()
        if (earned > 0) {
            tokens = minOf(burst, tokens + earned)
            refilledAt += earned * refillMs
        }
        // A full bucket banks no time: the next refill counts from now.
        if (tokens >= burst) refilledAt = now
        if (tokens <= 0) return false
        tokens -= 1
        return true
    }

    @Synchronized
    fun refund() {
        tokens = minOf(burst, tokens + 1)
    }

    companion object {
        const val BURST = 5
        const val REFILL_MS = 2_000L
    }
}

/** Which frame is a play, and whose, read once. */
data class PlayedSound(val channelId: String, val soundId: String, val userId: String?)

object SoundboardFrames {
    fun played(frame: JsonObject): PlayedSound? {
        if ((frame["type"] as? JsonPrimitive)?.contentOrNull != "soundboard-play") return null
        val channel = (frame["channelId"] as? JsonPrimitive)?.contentOrNull ?: return null
        val sound = (frame["soundId"] as? JsonPrimitive)?.contentOrNull ?: return null
        return PlayedSound(channel, sound, (frame["userId"] as? JsonPrimitive)?.contentOrNull)
    }

    fun playFrame(channelId: String, soundId: String): JsonObject = buildJsonObject {
        put("type", "soundboard-play")
        put("channelId", channelId)
        put("soundId", soundId)
    }

    /** The volume a clip plays at: the listener's own level times the clip's (`soundboardListenerVolume`). */
    fun gain(listener: Double, clip: Double): Float = (listener.coerceIn(0.0, 1.0) * clip.coerceIn(0.0, 1.0)).toFloat()
}

/**
 * Plays the room's clips on this phone and sends this phone's own.
 *
 * Application-scoped, like the voice controller: the call outlives every screen. A clip plays only while this
 * device is seated in the frame's channel and not deafened (a deafened client draws nothing and plays nothing,
 * `soundboardPlayedMessageSchema`); a custom clip's file is fetched from the server's catalog the first time it
 * is heard, and the catalog is read again, at most every [CATALOG_REFRESH_MS], when a play names a clip it does
 * not have (somebody added one since).
 */
class SoundboardController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val session: SessionStore,
    private val seatedChannelId: () -> String?,
    private val deafened: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val budget = PlayBudget()
    private val live = HashSet<MediaPlayer>()

    private val _available = MutableStateFlow<Availability>(Availability.Unknown)

    /** Whether the board is on for the call this phone is in, and the clips to draw. */
    val available: StateFlow<Availability> = _available.asStateFlow()

    private val serverByChannel = HashMap<String, String>()
    private var catalogAt = 0L

    sealed interface Availability {
        data object Unknown : Availability
        data object Off : Availability
        data class On(val channelId: String, val serverId: String, val sounds: List<CustomSound>) : Availability
    }

    init {
        scope.launch {
            session.realtime.frames.collect { frame ->
                when ((frame["type"] as? JsonPrimitive)?.contentOrNull) {
                    "soundboard-play" -> SoundboardFrames.played(frame)?.let(::onPlayed)
                }
            }
        }
    }

    // --- hearing ---

    private fun onPlayed(played: PlayedSound) {
        if (played.channelId != seatedChannelId() || deafened()) return
        val builtin = SoundboardBuiltins.byId(played.soundId)
        if (builtin != null) {
            play(builtin.raw, null, LISTENER_VOLUME.toFloat())
            return
        }
        scope.launch {
            val sound = customSound(played.channelId, played.soundId) ?: return@launch
            val url = Backend.absolute(sound.url) ?: return@launch
            play(0, url, SoundboardFrames.gain(LISTENER_VOLUME, sound.volume))
        }
    }

    private suspend fun customSound(channelId: String, soundId: String): CustomSound? {
        (_available.value as? Availability.On)?.takeIf { it.channelId == channelId }
            ?.sounds?.firstOrNull { it.id == soundId }?.let { return it }
        // Not known: the catalog may be older than the clip.
        val at = now()
        if (at - catalogAt < CATALOG_REFRESH_MS) return null
        catalogAt = at
        val serverId = serverOf(channelId) ?: return null
        val page = runSuspendCatching { session.api.soundboard(serverId) }.getOrNull() ?: return null
        _available.value = Availability.On(channelId, serverId, page.sounds)
        return page.sounds.firstOrNull { it.id == soundId }
    }

    private fun play(@RawRes raw: Int, url: String?, volume: Float) {
        // Twelve at once is the room's own cap; a phone holds fewer players than that and the extra is dropped.
        if (live.size >= MAX_LIVE) return
        val player = MediaPlayer()
        try {
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    // With the call, not over it: it follows the route the call chose (speaker or earpiece).
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            if (url != null) {
                player.setDataSource(url)
            } else {
                context.resources.openRawResourceFd(raw).use { player.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            }
            player.setVolume(volume, volume)
            player.setOnPreparedListener { it.start() }
            player.setOnCompletionListener { release(it) }
            player.setOnErrorListener { it, _, _ -> release(it); true }
            live += player
            player.prepareAsync()
        } catch (e: Exception) {
            Log.w(TAG, "clip would not play: ${e.message}")
            release(player)
        }
    }

    private fun release(player: MediaPlayer) {
        live -= player
        runCatching { player.release() }
    }

    // --- playing ---

    /** Which server the call's channel belongs to: asked of the server list once and remembered. */
    private suspend fun serverOf(channelId: String): String? {
        serverByChannel[channelId]?.let { return it }
        for (server in session.servers.value) {
            val channels = runSuspendCatching { session.api.channels(server.id) }.getOrNull() ?: continue
            channels.forEach { serverByChannel[it.id] = it.serverId ?: server.id }
            serverByChannel[channelId]?.let { return it }
        }
        return null
    }

    /**
     * Read whether the board is on for [channelId]'s server and what clips it holds. Called when the call bar
     * shows; nothing is drawn while the answer is [Availability.Unknown] or [Availability.Off].
     */
    fun refresh(channelId: String?) {
        if (channelId == null) {
            _available.value = Availability.Unknown
            return
        }
        scope.launch {
            val serverId = serverOf(channelId)
            if (serverId == null) {
                // A conversation call, or a server this phone cannot place: no board.
                _available.value = Availability.Off
                return@launch
            }
            val on = runSuspendCatching { session.api.voiceConfig(serverId) }.getOrNull()?.soundboard == true
            if (!on) {
                _available.value = Availability.Off
                return@launch
            }
            val page = runSuspendCatching { session.api.soundboard(serverId) }.getOrNull()
            catalogAt = now()
            _available.value = Availability.On(channelId, serverId, page?.sounds.orEmpty())
        }
    }

    /** A tile was tapped. False when the budget said wait (nothing was sent). */
    fun send(channelId: String, soundId: String): Boolean {
        if (!budget.take(now())) return false
        if (!session.realtime.send(SoundboardFrames.playFrame(channelId, soundId))) {
            budget.refund()
        }
        return true
    }

    companion object {
        private const val TAG = "pqp.soundboard"

        /** `soundboardListenerVolume`'s default, on the web. */
        const val LISTENER_VOLUME = 0.6
        const val MAX_LIVE = 8
        const val CATALOG_REFRESH_MS = 15_000L
    }
}
