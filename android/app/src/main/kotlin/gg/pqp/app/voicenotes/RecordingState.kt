package gg.pqp.app.voicenotes

/**
 * What the composer shows while a note is being recorded.
 *
 * [Active.levels] is the last few dozen input levels, 0 to 1, newest last, for
 * the live waveform in the locked panel. It is a display aid and nothing is
 * derived from it: the waveform that is sent comes from every raw sample the
 * recorder took.
 */
sealed interface RecordingUi {
    data object Idle : RecordingUi

    data class Active(
        val elapsedMs: Long,
        /** Slid up: hands-free, with pause and send. */
        val locked: Boolean,
        val paused: Boolean,
        val levels: List<Float>,
    ) : RecordingUi {
        /** Seconds left before the five minute stop, once it is close enough to matter. */
        val secondsLeft: Int?
            get() {
                val left = (VOICE_NOTE_MAX_DURATION_MS - elapsedMs) / 1000
                return if (left in 0..WARN_AT_SECONDS) left.toInt() else null
            }
    }

    companion object {
        /** The last ten seconds get a countdown. */
        const val WARN_AT_SECONDS = 10L
    }
}

/**
 * Something the recorder wants to say once, as a toast.
 *
 * An enum rather than a string: the sentence is a localised resource, and this
 * layer has no business holding one.
 */
enum class VoiceNotice {
    /** Refused to record: a pqp call is live and the microphone is its. */
    CallActive,

    /** Another app holds the microphone. */
    MicBusy,

    /** Released too soon to be a message. A hint, not an error. */
    TooShort,

    /** Stopped at five minutes and sent what there was. */
    LimitReached,
}

/** A note just thrown away, still undoable for [UNDO_WINDOW_MS]. */
data class DiscardedNote(val durationMs: Long)

/** How long "Discarded, undo" stays on offer. The mock says five seconds. */
const val UNDO_WINDOW_MS = 5_000L

/** Why a press on the microphone does not begin a recording. */
enum class RecordingRefusal {
    /** The `voice_notes` flag is off here, or there is no recorder. */
    Disabled,

    /** Already recording. A second press is not a second recording. */
    AlreadyRecording,

    /** An edit is in the box; a voice note has no words to edit. */
    Editing,

    /** A pqp call is live. The microphone is the call's. */
    CallActive,
}

/**
 * Whether a press may start recording, and if not, why.
 *
 * Pure, because the last of these is the rule the whole feature has to keep:
 * recording during a call would open a second capture on the microphone the
 * call is using, and on some devices that silences the call. The order is
 * deliberate: a live call is reported even when the flag is off, never the
 * other way round, so the one refusal a person is told about is not hidden
 * behind one they cannot act on.
 */
fun recordingRefusal(
    enabled: Boolean,
    alreadyRecording: Boolean,
    editing: Boolean,
    callActive: Boolean,
): RecordingRefusal? = when {
    alreadyRecording -> RecordingRefusal.AlreadyRecording
    callActive -> RecordingRefusal.CallActive
    !enabled -> RecordingRefusal.Disabled
    editing -> RecordingRefusal.Editing
    else -> null
}
