package gg.pqp.app.voicenotes

import android.content.Context
import android.media.AudioAttributes as PlatformAudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import gg.pqp.app.core.Backend
import gg.pqp.app.core.NoteListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** What the one player is doing, for every card on every screen to draw from. */
data class NotePlayback(
    /** The note that owns the player, or null when nothing does. */
    val attachmentId: String? = null,
    val playing: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    /** Sticky across notes for the session, the way the pill is on the web. */
    val speed: Float = 1f,
) {
    fun isCurrent(attachmentId: String): Boolean = this.attachmentId == attachmentId

    /** 0 to 1, for the waveform's played portion. */
    val fraction: Float
        get() = if (durationMs <= 0L) 0f else (positionMs.toFloat() / durationMs).coerceIn(0f, 1f)
}

/** Things the player wants to say out loud, once. */
enum class NoteNotice {
    /** Playback refused because a pqp call is live. */
    CallActive,

    /** The file would not play, even after a fresh link. */
    PlayFailed,
}

/**
 * The one voice note player in the app, and the record of what has been heard.
 *
 * ## One player, app-wide
 *
 * Two notes at once is never what anybody wants, and a per-row `ExoPlayer`
 * (the `VideoPlayerDialog` argument, in `VideoPlayer.kt`) is a codec per
 * visible row. So every card draws from [playback] and asks this object to
 * play, and starting a second note takes the first one's place. It lives on
 * the application for the same reason `VoiceController` does: leaving a chat
 * for the inbox must not cut a note off halfway, and the next unheard one
 * still has to start when this one ends.
 *
 * ## Audio focus, and a live call
 *
 * Focus is requested here as `AUDIOFOCUS_GAIN_TRANSIENT` rather than left to
 * ExoPlayer's own handling. ExoPlayer maps `USAGE_MEDIA` to a permanent gain,
 * which tells a music app to stop for good when a three-second note plays. A
 * voice note is a transient interruption, and asking for it as one is what
 * lets the music come back.
 *
 * It is **never** requested while a pqp call is live: a call holds focus as
 * voice communication, and a note starting beside it would either duck the
 * call or be ducked by it, both worse than saying no. [callActive] is read
 * before every start and watched while playing, so a call that connects under
 * a note stops the note instead of mixing it into the room.
 *
 * ## Listens
 *
 * A note counts as heard once it has played past a second, not when it is
 * tapped: a mis-tap is not a listen, and the sender sees "heard" on this.
 * The mark is optimistic (the dot goes at once) and the POST is best-effort
 * and idempotent. Your own notes never count, and the `voice-note-listened`
 * frame keeps two of your devices agreeing and tells an author who heard them.
 */
class VoiceNotes(
    private val context: Context,
    private val scope: CoroutineScope,
    /** `POST /api/attachments/:id/listened`. */
    private val reportListened: suspend (attachmentId: String) -> Unit,
    /** A fresh presigned URL, for the one retry an expired link earns. */
    private val freshUrl: suspend (attachmentId: String) -> String?,
    frames: Flow<JsonObject>,
    private val myId: () -> String?,
    private val callActive: StateFlow<Boolean>,
) {
    private val _playback = MutableStateFlow(NotePlayback())
    val playback: StateFlow<NotePlayback> = _playback.asStateFlow()

    private val _heard = MutableStateFlow<Set<String>>(emptySet())

    /** Attachment ids this person has heard since the app started. */
    val heard: StateFlow<Set<String>> = _heard.asStateFlow()

    private val _receipts = MutableStateFlow<Map<String, List<NoteListener>>>(emptyMap())

    /** Who else has played a note of ours, learned from the socket. */
    val receipts: StateFlow<Map<String, List<NoteListener>>> = _receipts.asStateFlow()

    private val _notices = MutableSharedFlow<NoteNotice>(extraBufferCapacity = 4)
    val notices: SharedFlow<NoteNotice> = _notices.asSharedFlow()

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())

    private var player: ExoPlayer? = null
    private var current: QueueEntry? = null
    private var queue: List<QueueEntry> = emptyList()
    private var queueChannel: String? = null
    private var ticker: Job? = null
    private var retriedUrl = false
    private var focusRequest: AudioFocusRequest? = null
    private var resumeOnGain = false

    /** Listens already sent (or in flight), so one play posts once. */
    private val reported = HashSet<String>()

    // --- what the screens call ---

    /**
     * The voice notes of [channelId]'s transcript, oldest first.
     *
     * Published whenever the transcript changes, and kept after the screen
     * leaves: the run that is playing can still continue into the next unheard
     * note of the channel it started in. An **empty** list is an answer too:
     * the last note was deleted, and the queue must forget it rather than
     * autoplay content that is gone. A queue for a different channel than the
     * one playing is the screen behind or ahead of it, and must not replace
     * the run in progress.
     */
    fun updateQueue(channelId: String, entries: List<QueueEntry>) {
        val playingChannel = current?.channelId
        if (playingChannel == null || playingChannel == channelId) {
            queue = entries
            queueChannel = channelId
        }
    }

    /** Tap on a card: play it, pause it, or resume it. */
    fun toggle(entry: QueueEntry) {
        val state = _playback.value
        if (state.isCurrent(entry.attachmentId)) {
            if (state.playing) pause() else resume()
            return
        }
        if (callActive.value) {
            _notices.tryEmit(NoteNotice.CallActive)
            return
        }
        start(entry)
    }

    fun cycleSpeed() {
        val next = PlaybackSpeeds.next(_playback.value.speed)
        _playback.value = _playback.value.copy(speed = next)
        player?.playbackParameters = PlaybackParameters(next, 1f)
    }

    /** Drag or tap on the waveform. Only the note that owns the player seeks. */
    fun seekTo(attachmentId: String, fraction: Float) {
        val state = _playback.value
        if (!state.isCurrent(attachmentId) || state.durationMs <= 0L) return
        val target = (state.durationMs * fraction.coerceIn(0f, 1f)).toLong()
        player?.seekTo(target)
        _playback.value = state.copy(positionMs = target)
    }

    /** The app left the foreground. A note is not a call: it does not keep going. */
    fun onAppBackgrounded() {
        if (_playback.value.playing) pause()
    }

    // --- playing ---

    private fun start(entry: QueueEntry) {
        release()
        if (!requestFocus()) {
            _notices.tryEmit(NoteNotice.PlayFailed)
            return
        }

        val exo = ExoPlayer.Builder(context).build().apply {
            // Focus is handled above, as a transient request. See the class
            // comment for why ExoPlayer is not left to do it.
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                    .build(),
                /* handleAudioFocus = */ false,
            )
            playbackParameters = PlaybackParameters(_playback.value.speed, 1f)
            addListener(listener)
            setMediaItem(MediaItem.fromUri(Backend.absolute(entry.url).orEmpty()))
            playWhenReady = true
            prepare()
        }
        player = exo
        current = entry
        retriedUrl = false
        resumeOnGain = false
        _playback.value = _playback.value.copy(
            attachmentId = entry.attachmentId,
            playing = true,
            positionMs = 0L,
            durationMs = entry.durationMs,
        )
        startTicker()
    }

    private fun pause() {
        player?.pause()
        resumeOnGain = false
        abandonFocus()
        _playback.value = _playback.value.copy(playing = false)
        ticker?.cancel()
    }

    private fun resume() {
        val exo = player ?: return
        if (callActive.value) {
            _notices.tryEmit(NoteNotice.CallActive)
            return
        }
        if (!requestFocus()) {
            _notices.tryEmit(NoteNotice.PlayFailed)
            return
        }
        exo.play()
        _playback.value = _playback.value.copy(playing = true)
        startTicker()
    }

    /** Stop and forget which note had the player. */
    fun stop() {
        release()
        _playback.value = _playback.value.copy(
            attachmentId = null,
            playing = false,
            positionMs = 0L,
            durationMs = 0L,
        )
    }

    private fun release() {
        ticker?.cancel()
        ticker = null
        player?.run {
            removeListener(listener)
            stop()
            release()
        }
        player = null
        current = null
        resumeOnGain = false
        abandonFocus()
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) onEnded()
        }

        override fun onPlayerError(error: PlaybackException) {
            val entry = current ?: return
            if (retriedUrl) {
                stop()
                _notices.tryEmit(NoteNotice.PlayFailed)
                return
            }
            // The presigned link can expire while a chat sits open. The first
            // failure is a better signal of that than any clock, so it earns
            // one fresh link, and a second failure is a real failure.
            retriedUrl = true
            scope.launch {
                val fresh = runCatching { freshUrl(entry.attachmentId) }.getOrNull()
                val exo = player
                if (fresh == null || exo == null || current?.attachmentId != entry.attachmentId) {
                    if (current?.attachmentId == entry.attachmentId) {
                        stop()
                        _notices.tryEmit(NoteNotice.PlayFailed)
                    }
                    return@launch
                }
                val resumeAt = exo.currentPosition
                exo.setMediaItem(MediaItem.fromUri(Backend.absolute(fresh).orEmpty()), resumeAt)
                exo.prepare()
                exo.playWhenReady = true
            }
        }
    }

    private fun onEnded() {
        val entry = current ?: return
        // The ticker marks a note once it has played for a second. One shorter
        // than that never will, and playing it to the end is hearing it: if it
        // did not count, such a note would keep its dot for ever and the queue
        // would offer it again every time.
        if (entry.durationMs <= LISTEN_AFTER_MS + TICK_MS) markHeard(entry)
        val next = if (entry.channelId == queueChannel) {
            VoiceNoteQueue.nextUnheard(queue, entry.attachmentId, myId(), _heard.value)
        } else {
            null
        }
        stop()
        if (next != null && !callActive.value) start(next)
    }

    private fun startTicker() {
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive) {
                val exo = player ?: break
                val entry = current ?: break
                val position = exo.currentPosition.coerceAtLeast(0L)
                val duration = exo.duration.takeIf { it != C.TIME_UNSET && it > 0L } ?: entry.durationMs
                _playback.value = _playback.value.copy(positionMs = position, durationMs = duration)
                if (position >= LISTEN_AFTER_MS) markHeard(entry)
                delay(TICK_MS)
            }
        }
    }

    // --- listens ---

    private fun markHeard(entry: QueueEntry) {
        if (entry.authorId == myId()) return
        if (entry.attachmentId !in _heard.value) _heard.value = _heard.value + entry.attachmentId
        if (entry.listenedByMe || !reported.add(entry.attachmentId)) return
        scope.launch {
            // A few tries, with `reported` held the whole time: a replay while
            // the first request is in flight must not send a second one, and
            // must not be the only thing that retries a failed first.
            var recorded = false
            for (attempt in 0 until REPORT_ATTEMPTS) {
                if (attempt > 0) delay(REPORT_RETRY_MS * attempt)
                recorded = runCatching { reportListened(entry.attachmentId) }.isSuccess
                if (recorded) break
            }
            // Never recorded: let the next play try again rather than
            // pretending the sender was told.
            if (!recorded) reported.remove(entry.attachmentId)
        }
    }

    private fun onFrame(frame: JsonObject) {
        when ((frame["type"] as? JsonPrimitive)?.contentOrNull) {
            "voice-note-listened" -> onListened(frame)
        }
    }

    /**
     * `voice-note-listened`. Two readers: the listener's own other devices,
     * who clear their dot, and the author in a conversation, who learns who
     * heard it.
     */
    private fun onListened(frame: JsonObject) {
        val attachmentId = frame.string("attachmentId") ?: return
        val userId = frame.string("userId") ?: return
        if (userId == myId()) {
            _heard.value = _heard.value + attachmentId
            reported.add(attachmentId)
            return
        }
        val listener = NoteListener(userId, frame.string("listenedAt"))
        val existing = _receipts.value[attachmentId].orEmpty()
        if (existing.any { it.userId == userId }) return
        _receipts.value = _receipts.value + (attachmentId to existing + listener)
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull

    // --- audio focus ---

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        val exo = player ?: return@OnAudioFocusChangeListener
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> pause()

            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> if (exo.isPlaying) {
                resumeOnGain = true
                exo.pause()
                // Nothing is playing, so nothing to poll until focus returns.
                ticker?.cancel()
                _playback.value = _playback.value.copy(playing = false)
            }

            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> exo.volume = DUCKED_VOLUME

            AudioManager.AUDIOFOCUS_GAIN -> {
                exo.volume = 1f
                if (resumeOnGain && !callActive.value) {
                    resumeOnGain = false
                    exo.play()
                    _playback.value = _playback.value.copy(playing = true)
                    startTicker()
                }
            }
        }
    }

    private fun requestFocus(): Boolean {
        if (callActive.value) return false
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                PlatformAudioAttributes.Builder()
                    .setUsage(PlatformAudioAttributes.USAGE_MEDIA)
                    .setContentType(PlatformAudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener(focusListener, main)
            .build()
        val granted = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (granted) focusRequest = request
        return granted
    }

    private fun abandonFocus() {
        focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    init {
        // Last, so that everything the callbacks touch is already built.
        scope.launch { frames.collect { onFrame(it) } }
        scope.launch {
            callActive.collect { active -> if (active) stop() }
        }
    }

    companion object {
        /** A listen is a second of playback, not a tap. */
        const val LISTEN_AFTER_MS = 1_000L
        private const val TICK_MS = 100L
        private const val REPORT_ATTEMPTS = 3
        private const val REPORT_RETRY_MS = 3_000L
        private const val DUCKED_VOLUME = 0.25f
    }
}
