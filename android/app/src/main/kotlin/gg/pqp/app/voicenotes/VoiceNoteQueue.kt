package gg.pqp.app.voicenotes

import gg.pqp.app.core.Message

/**
 * One voice note the player could be asked to play, with just what the queue
 * and the player need and nothing they would have to keep fresh.
 *
 * Distinct from `Attachment` on purpose: the queue is built from a transcript
 * that changes under it (a message arrives, one is deleted, an optimistic row
 * is swapped for the real one), and an entry is a value that can be thrown
 * away and rebuilt on every change.
 */
data class QueueEntry(
    val attachmentId: String,
    val messageId: String,
    val channelId: String,
    val authorId: String,
    val url: String,
    val durationMs: Long,
    /** The server already knows this person heard it. Folded with the local set. */
    val listenedByMe: Boolean,
)

object VoiceNoteQueue {

    /**
     * Every voice note in a transcript, oldest first.
     *
     * The transcript the view model holds is already in reading order, so this
     * keeps that order rather than sorting on a timestamp that two messages
     * can share. A message with several attachments contributes each note it
     * has, though the server allows a note only on its own.
     */
    fun entriesOf(messages: List<Message>): List<QueueEntry> =
        messages.flatMap { message ->
            if (message.blocked) return@flatMap emptyList()
            message.attachments.mapNotNull { attachment ->
                val voice = attachment.voice ?: return@mapNotNull null
                if (!attachment.isVoiceNote) return@mapNotNull null
                QueueEntry(
                    attachmentId = attachment.id,
                    messageId = message.id,
                    channelId = message.channelId,
                    authorId = message.authorId,
                    url = attachment.url,
                    durationMs = voice.durationMs,
                    listenedByMe = voice.listenedByMe,
                )
            }
        }

    /**
     * The note to play after [currentId] finishes, or null when the run is
     * over.
     *
     * The next one **after** the current in reading order that somebody else
     * sent and this person has not heard. Skipping what is already heard is
     * the point: listening to a backlog should drain it like a podcast, not
     * replay the note you came back for. Skipping your own is the other half:
     * a queue that read your own voice back to you between two friends'
     * messages would be a bug report.
     *
     * Never wraps around. A note earlier than the current one that is still
     * unheard stays unheard, and starting to play from the middle of a backlog
     * must not suddenly turn back toward it.
     *
     * Null when the current note is not in the queue at all (its message was
     * deleted while it played): there is nothing to continue from, and
     * guessing would play something nobody asked for.
     */
    fun nextUnheard(
        queue: List<QueueEntry>,
        currentId: String,
        myId: String?,
        heardLocally: Set<String>,
    ): QueueEntry? {
        val index = queue.indexOfFirst { it.attachmentId == currentId }
        if (index < 0) return null
        for (i in index + 1 until queue.size) {
            val candidate = queue[i]
            if (candidate.authorId == myId) continue
            if (candidate.listenedByMe || candidate.attachmentId in heardLocally) continue
            return candidate
        }
        return null
    }
}

/** The speeds the pill cycles through, in the order the mocks show them. */
object PlaybackSpeeds {
    val all: List<Float> = listOf(1f, 1.5f, 2f)

    /** The speed after [current]; anything unrecognised starts over at 1x. */
    fun next(current: Float): Float {
        val index = all.indexOfFirst { kotlin.math.abs(it - current) < 0.01f }
        return if (index < 0) all.first() else all[(index + 1) % all.size]
    }

    /** `1x`, `1.5x`, `2x`: no trailing zero, no locale decimal comma on a pill. */
    fun label(speed: Float): String =
        if (speed == speed.toInt().toFloat()) "${speed.toInt()}x" else "${speed}x"
}
