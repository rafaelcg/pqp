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
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
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
 * `soundboardPlayedMessageSchema`), and that is checked again at the moment a clip that had to be looked up or
 * downloaded is about to sound, so leaving or deafening mid-lookup stays silent.
 *
 * A custom clip is downloaded once to the cache and played from there; the catalog is read again, at most every
 * [CATALOG_REFRESH_MS], when a play names a clip it does not have, by ONE shared read that every waiting play
 * resolves against. A clip whose file would not download (its link expired) forgets the catalog so the next play
 * reads a fresh one.
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


    /** When each channel's catalog was last read, and the read in flight: per channel, never shared across calls. */
    private val catalogAt = Freshness(now, CATALOG_REFRESH_MS, FRESHNESS_CAP)
    private val catalogReads = HashMap<String, Deferred<List<CustomSound>?>>()

    /** Which refresh is the current one: an older one that finishes late writes nothing. */
    private var refreshGeneration = 0
    private var refreshJob: Job? = null

    sealed interface Availability {
        /** Not asked yet, or the last ask failed and is being tried again: nothing is drawn. */
        data object Unknown : Availability

        /** Asked and answered: no board here (a conversation call, or the flag is off). */
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

    private fun stillAudible(channelId: String): Boolean = channelId == seatedChannelId() && !deafened()

    private fun onPlayed(played: PlayedSound) {
        if (!stillAudible(played.channelId)) return
        val builtin = SoundboardBuiltins.byId(played.soundId)
        if (builtin != null) {
            play(builtin.raw, null, LISTENER_VOLUME.toFloat()) { stillAudible(played.channelId) }
            return
        }
        scope.launch {
            val sound = customSound(played.channelId, played.soundId) ?: return@launch
            val file = clipFile(played.channelId, sound) ?: return@launch
            // The lookup and the download took time: the call may have been left, or the phone deafened, since.
            if (!stillAudible(played.channelId)) return@launch
            play(0, file, SoundboardFrames.gain(LISTENER_VOLUME, sound.volume)) { stillAudible(played.channelId) }
        }
    }

    private fun known(channelId: String, soundId: String): CustomSound? =
        (_available.value as? Availability.On)?.takeIf { it.channelId == channelId }
            ?.sounds?.firstOrNull { it.id == soundId }

    private suspend fun customSound(channelId: String, soundId: String): CustomSound? {
        known(channelId, soundId)?.let { return it }
        // Not known: the catalog may be older than the clip. One read at a time; every waiting play resolves against it.
        val read = synchronized(catalogAt) {
            val running = catalogReads[channelId]
            when {
                running != null && running.isActive -> running
                catalogAt.isFresh(channelId) -> return null
                else -> scope.async { readCatalog(channelId) }.also { flight ->
                    catalogReads[channelId] = flight
                    // Callers hold their own reference; the map keeps a read only while it runs.
                    flight.invokeOnCompletion {
                        synchronized(catalogAt) { if (catalogReads[channelId] === flight) catalogReads.remove(channelId) }
                    }
                }
            }
        }
        val sounds = read.await() ?: return null
        return sounds.firstOrNull { it.id == soundId }
    }

    /** Read the catalog of [channelId]'s server and publish it; null when it could not be read. */
    private suspend fun readCatalog(channelId: String): List<CustomSound>? {
        val serverId = (serverOf(channelId) as? ChannelOwners.Lookup.Found)?.serverId ?: return null
        val page = runSuspendCatching { session.api.soundboard(serverId) }.getOrNull() ?: return null
        synchronized(catalogAt) { catalogAt.mark(channelId) }
        if (channelId == seatedChannelId()) _available.value = Availability.On(channelId, serverId, page.sounds)
        return page.sounds
    }

    /**
     * [audible] is asked again when the player is ready: it prepares asynchronously, and a call left or a phone
     * deafened in that gap must stay silent, so it is released without starting.
     */
    private fun play(@RawRes raw: Int, file: File?, volume: Float, audible: () -> Boolean = { true }) {
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
            if (file != null) {
                player.setDataSource(file.absolutePath)
            } else {
                context.resources.openRawResourceFd(raw).use { player.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
            }
            player.setVolume(volume, volume)
            player.setOnPreparedListener { if (audible()) it.start() else release(it) }
            player.setOnCompletionListener { release(it) }
            player.setOnErrorListener { it, _, _ ->
                // A file that will not play is not kept: the next play downloads it again.
                file?.delete()
                release(it)
                true
            }
            live += player
            player.prepareAsync()
        } catch (e: Exception) {
            Log.w(TAG, "clip would not play: ${e.message}")
            file?.delete()
            release(player)
        }
    }

    private fun release(player: MediaPlayer) {
        live -= player
        runCatching { player.release() }
    }

    // --- the clips on disk ---

    /**
     * The custom clip as a file in the cache, downloaded once. The name carries the clip's id and the storage
     * path of its link without the signature, so the same clip is never fetched twice and a replaced one is.
     * A link that will not download (it expired, or storage had none) forgets the catalog, so the next play
     * reads a fresh one instead of reusing the dead link for the rest of the call.
     */
    private suspend fun clipFile(channelId: String, sound: CustomSound): File? {
        val url = Backend.absolute(sound.url)
        if (url == null) {
            synchronized(catalogAt) { catalogAt.forget(channelId) }
            return null
        }
        val dir = File(context.cacheDir, "soundboard").apply { mkdirs() }
        val file = File(dir, "${sound.id}-${url.substringBefore('?').hashCode().toUInt()}.clip")
        if (file.exists() && file.length() > 0) return file
        // One download per clip however many plays name it at once: the others wait for the same file.
        val got = downloads.run(file.name) {
            withContext(Dispatchers.IO) { download(url, dir, file) }
        }
        if (!got) synchronized(catalogAt) { catalogAt.forget(channelId) }
        return file.takeIf { got }
    }

    private val downloads = SingleFlight<String, Boolean>(scope)

    /**
     * Into a temporary file of its own, then moved over the destination. A failure removes only the temporary
     * file, never the destination (which another play may be reading, or may have just finished writing).
     */
    private fun download(url: String, dir: File, file: File): Boolean {
        val partial = File.createTempFile("${file.name}.", ".part", dir)
        return try {
            val request = okhttp3.Request.Builder().url(url).build()
            session.http.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "HTTP ${response.code}" }
                partial.outputStream().use { out -> response.body.byteStream().copyTo(out) }
            }
            check(partial.length() > 0) { "empty clip" }
            check(partial.renameTo(file)) { "could not move into place" }
            true
        } catch (e: Exception) {
            Log.w(TAG, "clip would not download: ${e.message}")
            partial.delete()
            false
        }
    }

    // --- which server ---

    private val owners = ChannelOwners()

    /**
     * Which server the call's channel belongs to. Servers are read one after the other and the search STOPS at
     * the one that holds the channel, so a member of many servers is not sent a request for each of them; every
     * channel read on the way is remembered, and a server already read is never read again.
     */
    private suspend fun serverOf(channelId: String): ChannelOwners.Lookup =
        owners.find(channelId, session.servers.value.map { it.id }) { serverId ->
            runSuspendCatching { session.api.channels(serverId) }.getOrNull()?.map { it.id to (it.serverId ?: serverId) }
        }

    // --- the board ---

    /**
     * Read whether the board is on for [channelId]'s server and what clips it holds. Called when the call bar
     * shows. Only the latest call's answer is written (an older one finishing late is ignored, and a newer ask
     * cancels it), and a read that FAILED leaves the state unknown and is tried again with a growing wait: `Off`
     * is only ever the server's own answer, never a dropped request.
     */
    fun refresh(channelId: String?) {
        refreshJob?.cancel()
        val generation = ++refreshGeneration
        if (channelId == null) {
            _available.value = Availability.Unknown
            return
        }
        refreshJob = scope.launch {
            var wait = RETRY_BASE_MS
            repeat(RETRY_LIMIT) {
                val answer = ask(channelId)
                if (generation != refreshGeneration) return@launch
                if (answer != null) {
                    _available.value = answer
                    return@launch
                }
                _available.value = Availability.Unknown
                delay(wait)
                wait *= 2
            }
        }
    }

    /** The server's answer for [channelId], or null when a request failed and nothing can be said yet. */
    private suspend fun ask(channelId: String): Availability? {
        val serverId = when (val found = serverOf(channelId)) {
            is ChannelOwners.Lookup.Found -> found.serverId
            // A conversation call: no server, no board.
            ChannelOwners.Lookup.None -> return Availability.Off
            ChannelOwners.Lookup.Failed -> return null
        }
        val config = runSuspendCatching { session.api.voiceConfig(serverId) }.getOrNull() ?: return null
        if (!config.soundboard) return Availability.Off
        val page = runSuspendCatching { session.api.soundboard(serverId) }.getOrNull() ?: return null
        synchronized(catalogAt) { catalogAt.mark(channelId) }
        return Availability.On(channelId, serverId, page.sounds)
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

        /** Most channels whose catalog age is remembered; the oldest go first. */
        const val FRESHNESS_CAP = 16

        /** A failed read of the board is asked again after 3 s, 6 s, 12 s, 24 s, then left. */
        const val RETRY_BASE_MS = 3_000L
        const val RETRY_LIMIT = 5
    }
}

/**
 * Which server a channel belongs to, found by reading servers' channel lists ONE AT A TIME and stopping at the
 * first that holds it. Everything read is remembered (channel to server, and which servers were read), so a
 * second lookup for a channel in a server already read costs nothing and none is read twice.
 */
class ChannelOwners(
    private val now: () -> Long = System::currentTimeMillis,
    /** How long a server's channel list is trusted: a channel added since is found once it is older than this. */
    private val ttlMs: Long = READ_TTL_MS,
) {
    sealed interface Lookup {
        data class Found(val serverId: String) : Lookup

        /** Every server was read and none holds the channel: a conversation call. */
        data object None : Lookup

        /** A server that was not yet read could not be: nothing can be concluded. */
        data object Failed : Lookup
    }

    private val serverByChannel = HashMap<String, String>()
    private val readAt = HashMap<String, Long>()

    /** [fetch] answers a server's channels as (channel id, owning server id), or null when it could not be read. */
    suspend fun find(
        channelId: String,
        servers: List<String>,
        fetch: suspend (serverId: String) -> List<Pair<String, String>>?,
    ): Lookup {
        synchronized(this) { serverByChannel[channelId] }?.let { return Lookup.Found(it) }
        var failed = false
        for (serverId in servers) {
            if (synchronized(this) { readAt[serverId]?.let { now() - it < ttlMs } == true }) continue
            val channels = fetch(serverId)
            if (channels == null) {
                failed = true
                continue
            }
            val owner = synchronized(this) {
                readAt[serverId] = now()
                channels.forEach { (id, owning) -> serverByChannel[id] = owning }
                serverByChannel[channelId]
            }
            if (owner != null) return Lookup.Found(owner)
        }
        return if (failed) Lookup.Failed else Lookup.None
    }

    companion object {
        const val READ_TTL_MS = 60_000L
    }
}

/**
 * One piece of work per key at a time: callers that arrive while it runs wait for the same result instead of
 * starting another. The key is forgotten when the work ends, so a failure can be tried again.
 */
class SingleFlight<K, V>(private val scope: CoroutineScope) {
    private val running = HashMap<K, Deferred<V>>()

    suspend fun run(key: K, work: suspend () -> V): V {
        val flight = synchronized(this) {
            running[key] ?: scope.async(start = CoroutineStart.LAZY) {
                try {
                    work()
                } finally {
                    synchronized(this@SingleFlight) { running.remove(key) }
                }
            }.also { running[key] = it }
        }
        return flight.await()
    }
}

/**
 * When each key was last marked, trusted for [windowMs], and bounded: entries past the window are dropped as new
 * ones arrive, and past [cap] the oldest go, so visiting many channels over a long session does not accumulate.
 */
class Freshness(
    private val now: () -> Long,
    private val windowMs: Long,
    private val cap: Int,
) {
    private val at = LinkedHashMap<String, Long>()

    val size: Int get() = synchronized(at) { at.size }

    fun isFresh(key: String): Boolean = synchronized(at) { at[key]?.let { now() - it < windowMs } == true }

    fun mark(key: String) {
        synchronized(at) {
            val t = now()
            at.remove(key)
            at[key] = t
            val iterator = at.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (t - entry.value >= windowMs || at.size > cap) iterator.remove() else break
            }
        }
    }

    fun forget(key: String) {
        synchronized(at) { at.remove(key) }
    }
}
