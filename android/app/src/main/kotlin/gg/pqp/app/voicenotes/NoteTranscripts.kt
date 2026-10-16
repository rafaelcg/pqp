package gg.pqp.app.voicenotes

import gg.pqp.app.core.ApiException
import gg.pqp.app.core.NoteTranscript
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Where a request for one note stands, for the card's button (`TranscriptRequestState` on the web):
 *  - [Idle]: nothing asked, or an earlier ask failed in a way worth retrying.
 *  - [Refused]: the server will not transcribe this note for this person (flag off here, the sender
 *    declined, a preference says no) or it is gone. The card draws nothing to ask with.
 *  - [Slow]: the limiter said slow down; the button is back after a moment.
 *  - [Failed]: the request did not reach the server.
 */
enum class TranscriptRequest { Idle, Refused, Slow, Failed }

/**
 * Voice note transcripts, as the app holds them. The same rules as the web's
 * `client/src/lib/voice-note-transcript.ts`.
 *
 * A transcript arrives two ways: on the attachment read (`voice.transcript`, the BASE, which a message
 * carries for as long as it is in memory) and as a `voice-note-transcript` frame on the note's channel
 * when a job settles or is asked for. Like the listen receipts, the frames land in a store keyed by
 * attachment id rather than being threaded through every copy of the message, and a card reads the two
 * together with [resolve].
 *
 * The base decides WHETHER there is a transcript at all: the server leaves the block off when the
 * `voice_note_transcription` flag is off where the note lives, and when its sender did not allow it. A
 * stored frame therefore never makes a card draw text the base did not allow.
 *
 * Application-scoped, like [VoiceNotes]: a frame for a note whose screen is gone still has to land.
 */
class NoteTranscripts(
    private val scope: CoroutineScope,
    frames: Flow<JsonObject>,
    /** `POST /api/attachments/:id/transcript`; throws [ApiException] for a refusal. */
    private val requestFn: suspend (attachmentId: String) -> NoteTranscript,
    private val recheckAfterMs: Long = RECHECK_AFTER_MS,
    private val slowDownMs: Long = SLOW_DOWN_MS,
) {
    private val lock = Any()

    private val _stored = MutableStateFlow<Map<String, NoteTranscript>>(emptyMap())

    /** What frames and our own requests have said, newest last. */
    val stored: StateFlow<Map<String, NoteTranscript>> = _stored.asStateFlow()

    private val _requests = MutableStateFlow<Map<String, TranscriptRequest>>(emptyMap())
    val requests: StateFlow<Map<String, TranscriptRequest>> = _requests.asStateFlow()

    private val _seen = MutableStateFlow(false)

    /**
     * Whether anything in this session has shown that transcription exists: a note arrived with a
     * transcript block. The flag is per server, so settings cannot ask one question and trust it.
     */
    val seen: StateFlow<Boolean> = _seen.asStateFlow()

    /** Notes shown as `pending` because we asked, before the server said so. */
    private val optimistic = HashSet<String>()
    private val inFlight = HashMap<String, Job>()
    private val rechecks = HashMap<String, Job>()

    init {
        scope.launch { frames.collect(::onFrame) }
    }

    // --- reading ---

    /** A card saw a transcript block on a note it was drawing. */
    fun markAvailable() {
        _seen.value = true
    }

    private fun onFrame(frame: JsonObject) {
        when ((frame["type"] as? JsonPrimitive)?.contentOrNull) {
            "voice-note-transcript" -> {
                val id = (frame["attachmentId"] as? JsonPrimitive)?.contentOrNull ?: return
                val transcript = decodeTranscript(frame["transcript"] as? JsonObject) ?: return
                synchronized(lock) {
                    optimistic.remove(id)
                    put(id, transcript)
                    // Settled: nobody needs to ask again for this note.
                    if (transcript.status != "pending") cancelRecheck(id)
                }
            }
        }
    }

    private fun put(id: String, transcript: NoteTranscript) {
        val previous = _stored.value[id]
        if (previous != null &&
            previous.status == transcript.status &&
            previous.text == transcript.text &&
            previous.language == transcript.language
        ) {
            return
        }
        // Re-inserted so the oldest key is the least recently updated.
        val next = LinkedHashMap(_stored.value)
        next.remove(id)
        next[id] = transcript
        evict(next)
        _stored.value = next
    }

    /**
     * A phone that stays open for days receives a frame for every note settled in every channel it is
     * joined to, so the store is a cache and not a ledger: past [MAX_STORED] the oldest one nobody is
     * waiting on is dropped. That loses nothing, because a card's base carries the same transcript.
     */
    private fun evict(map: LinkedHashMap<String, NoteTranscript>) {
        if (map.size <= MAX_STORED) return
        val iterator = map.keys.iterator()
        while (map.size > MAX_STORED && iterator.hasNext()) {
            val key = iterator.next()
            if (key in inFlight || key in optimistic || key in rechecks) continue
            iterator.remove()
        }
    }

    // --- asking ---

    /**
     * "Transcrever" was pressed. At most one request per note is ever in flight, however many cards
     * show it and however fast the button is pressed. The note reads as `pending` the moment it is
     * asked for, so the card does not sit on a button that has already been used.
     */
    fun request(attachmentId: String) {
        synchronized(lock) {
            if (attachmentId in inFlight) return
            val current = _stored.value[attachmentId]
            if (current == null || current.status == "none" || current.status == "unavailable") {
                optimistic.add(attachmentId)
                put(attachmentId, NoteTranscript(status = "pending"))
            }
            setRequest(attachmentId, TranscriptRequest.Idle)
            ask(attachmentId, 0)
        }
    }

    private fun ask(attachmentId: String, recheck: Int) {
        if (attachmentId in inFlight) return
        // LAZY, so the job is registered before it can possibly finish: on an immediate dispatcher a
        // request that fails at once would otherwise remove its entry before it was ever added.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val transcript = requestFn(attachmentId)
                synchronized(lock) {
                    optimistic.remove(attachmentId)
                    setRequest(attachmentId, TranscriptRequest.Idle)
                    // The frame can beat the HTTP answer: a note that settled while this 202 was on
                    // its way stays settled.
                    val current = _stored.value[attachmentId]
                    val settledAlready = current != null && current.status != "none" && current.status != "pending"
                    if (!(transcript.status == "pending" && settledAlready)) put(attachmentId, transcript)
                    if (transcript.status == "pending" && !settledAlready) {
                        scheduleRecheck(attachmentId, recheck)
                    } else {
                        cancelRecheck(attachmentId)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val status = (e as? ApiException)?.status ?: 0
                synchronized(lock) {
                    when {
                        status == 403 || status == 404 -> {
                            dropPending(attachmentId)
                            setRequest(attachmentId, TranscriptRequest.Refused)
                        }
                        // A recheck that did not get through (offline, a 5xx, the limiter) tries again
                        // on its own clock, and gives up the way the rest do. The count is advanced by
                        // the timer (it asks as `count + 1`), so a run of failures reaches the limit.
                        recheck > 0 -> scheduleRecheck(attachmentId, recheck)
                        else -> {
                            takeBackOptimism(attachmentId)
                            if (status == 429) {
                                setRequest(attachmentId, TranscriptRequest.Slow)
                                scope.launch {
                                    delay(slowDownMs)
                                    synchronized(lock) {
                                        if (_requests.value[attachmentId] == TranscriptRequest.Slow) {
                                            setRequest(attachmentId, TranscriptRequest.Idle)
                                        }
                                    }
                                }
                            } else {
                                setRequest(attachmentId, TranscriptRequest.Failed)
                            }
                        }
                    }
                }
            } finally {
                synchronized(lock) { inFlight.remove(attachmentId) }
            }
        }
        inFlight[attachmentId] = job
        job.start()
    }

    /**
     * A job that was queued answers with a frame. If that frame never arrives (a socket that dropped
     * in the gap, a worker restart) the card would shimmer for good, so a request WE made asks again,
     * a few times, a little later. Asking is idempotent on the server.
     */
    private fun scheduleRecheck(attachmentId: String, count: Int) {
        cancelRecheck(attachmentId)
        if (count >= RECHECK_LIMIT) {
            dropPending(attachmentId)
            return
        }
        rechecks[attachmentId] = scope.launch {
            delay(recheckAfterMs)
            synchronized(lock) {
                rechecks.remove(attachmentId)
                if (_stored.value[attachmentId]?.status != "pending") return@launch
                ask(attachmentId, count + 1)
            }
        }
    }

    private fun cancelRecheck(attachmentId: String) {
        rechecks.remove(attachmentId)?.cancel()
    }

    /**
     * Stop showing "transcrevendo" for a note we have stopped waiting on. What the card falls back to
     * is its read: a "Transcrever" button on a note that had none, so the person can ask again, or
     * whatever the server last said.
     */
    private fun dropPending(attachmentId: String) {
        cancelRecheck(attachmentId)
        optimistic.remove(attachmentId)
        if (_stored.value[attachmentId]?.status == "pending") {
            _stored.value = _stored.value - attachmentId
        }
    }

    /** The request did not take: the note is what it was before we asked. */
    private fun takeBackOptimism(attachmentId: String) {
        if (optimistic.remove(attachmentId) && _stored.value[attachmentId]?.status == "pending") {
            _stored.value = _stored.value - attachmentId
        }
    }

    private fun setRequest(attachmentId: String, next: TranscriptRequest) {
        val current = _requests.value[attachmentId] ?: TranscriptRequest.Idle
        if (current == next) return
        _requests.value = if (next == TranscriptRequest.Idle) _requests.value - attachmentId else _requests.value + (attachmentId to next)
    }

    companion object {
        /** A transcript is final once it is one of these. */
        private val STATUSES = setOf("none", "pending", "done", "no_speech", "failed", "unavailable")

        const val MAX_STORED = 400

        /** How long the limiter's answer keeps the button away. */
        const val SLOW_DOWN_MS = 8_000L

        const val RECHECK_AFTER_MS = 45_000L
        const val RECHECK_LIMIT = 4

        /**
         * The transcript to draw: what the message was read with, or what a frame or our own request has
         * said since. The stored answer wins, with one exception: a `done` base is final, because a
         * message re-read after a reconnect can carry the finished text while this phone still holds the
         * `pending` it was told first. No base, no transcript.
         */
        fun resolve(base: NoteTranscript?, fromStore: NoteTranscript?): NoteTranscript? {
            if (base == null) return null
            if (fromStore == null) return base
            if (base.status == "done" && fromStore.status != "done") return base
            return fromStore
        }

        /** A transcript block from a frame, or null when it names a status this build does not know. */
        internal fun decodeTranscript(block: JsonObject?): NoteTranscript? {
            block ?: return null
            val status = (block["status"] as? JsonPrimitive)?.contentOrNull ?: return null
            if (status !in STATUSES) return null
            return NoteTranscript(
                status = status,
                text = (block["text"] as? JsonPrimitive)?.contentOrNull,
                language = (block["language"] as? JsonPrimitive)?.contentOrNull,
            )
        }
    }
}
