package gg.pqp.app.voicenotes

import java.util.Base64
import kotlin.math.ceil
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * What a voice note is, in numbers the server will check.
 *
 * Every constant here is a hand-copy of `packages/shared/src/attachments.ts`
 * and `VoiceNoteContractTest` reads that file off disk to keep them honest.
 * Getting one wrong is not a compile error on either side: it is a 400 from a
 * mint the person never sees, after they have spoken for a minute.
 */

/** Shorter than this is a tap on the microphone, not a message. */
const val VOICE_NOTE_MIN_DURATION_MS = 300L

/** Five minutes, the recorder's hard stop. */
const val VOICE_NOTE_MAX_DURATION_MS = 5L * 60 * 1000

/** Peaks the card draws, one byte each. */
const val VOICE_NOTE_WAVEFORM_PEAKS = 64

/**
 * The only container this client records, sent bare.
 *
 * MediaRecorder writes AAC-LC in MPEG-4, and every platform plays that, so it
 * never needs the transcode an Opus note gets. The type is **bare** (no
 * `;codecs=`) because the claim HEADs the stored object and compares the type
 * to the signed one exactly.
 */
const val VOICE_NOTE_CONTENT_TYPE = "audio/mp4"

/** The name the server stores. It is shown nowhere: the card draws no filename. */
const val VOICE_NOTE_FILENAME = "voice-note.m4a"

/**
 * The bytes a note of this length may take, checked at mint
 * (`noteByteBudget` in shared). 16 KiB a second is 128 kbps, and this
 * recorder runs at 48, so a healthy note is a third of the budget. Checked
 * here as well so a corrupt file is refused before it is uploaded.
 */
fun noteByteBudget(durationMs: Long): Long =
    16L * 1024 * ceil(durationMs / 1000.0).toLong() + 32L * 1024

/** `0:12`, `4:05`. Whole seconds, never below one, like `formatNoteDuration` in shared. */
fun formatNoteDuration(durationMs: Long): String {
    val seconds = maxOf(1L, (durationMs / 1000.0).roundToInt().toLong())
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}

/**
 * The clock while playing: how far in, as `0:07`.
 *
 * Floors rather than rounds, unlike [formatNoteDuration]. A clock that rounds
 * up shows `0:01` at the very first frame, and a progress readout that has
 * already moved before anything has played reads as a bug.
 */
fun formatPlaybackClock(positionMs: Long): String {
    val seconds = maxOf(0L, positionMs / 1000)
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}

/**
 * Turns `MediaRecorder.getMaxAmplitude` samples into the 64 bytes a note
 * carries.
 *
 * The recorder samples about every 80 ms, so a note is a few dozen samples or
 * a few thousand and the card always draws exactly [VOICE_NOTE_WAVEFORM_PEAKS]
 * bars. Each bar is the **loudest** sample in its slice of the recording, not
 * the average: an average flattens speech into a ripple, and the peak is what
 * the eye reads as "something was said here".
 *
 * Normalised against the loudest peak of this recording rather than against
 * the 16-bit ceiling, so a quiet room and a loud one both fill the card. A
 * floor on that reference stops a recording of near-silence being amplified
 * into a wall of full-height bars, which would say "loud" about a note that was
 * not. A square root then spreads the range, because raw amplitude is so
 * peaky that linear bars are a few spikes over a flat line.
 */
object PeakNormalizer {

    /** `getMaxAmplitude` tops out at the signed 16-bit ceiling. */
    const val MAX_AMPLITUDE = 32767

    /**
     * Below this, a recording is treated as quiet rather than stretched to
     * fill the card. About 4.5% of full scale: the noise floor of a phone mic
     * in a still room.
     */
    const val QUIET_FLOOR = 1500

    /** The peaks as raw bytes, always [VOICE_NOTE_WAVEFORM_PEAKS] of them. */
    fun peaks(amplitudes: IntArray, count: Int = VOICE_NOTE_WAVEFORM_PEAKS): ByteArray {
        val out = ByteArray(count)
        if (amplitudes.isEmpty()) return out

        val clean = IntArray(amplitudes.size) { amplitudes[it].coerceIn(0, MAX_AMPLITUDE) }
        val loudest = clean.max()
        val reference = maxOf(loudest, QUIET_FLOOR).toDouble()

        for (bar in 0 until count) {
            // The slice of samples this bar covers. When there are fewer
            // samples than bars the slices overlap on one sample, which
            // stretches a short note across the card instead of leaving the
            // right of it empty.
            val from = (bar.toLong() * clean.size / count).toInt()
            val to = maxOf(from + 1, ((bar + 1).toLong() * clean.size / count).toInt())
                .coerceAtMost(clean.size)
            var peak = 0
            for (i in from until to) if (clean[i] > peak) peak = clean[i]

            val scaled = sqrt(peak / reference) * 255.0
            out[bar] = scaled.roundToInt().coerceIn(0, 255).toByte()
        }
        return out
    }

    /** The wire form: base64, which for 64 bytes is 88 characters ending `==`. */
    fun encode(amplitudes: IntArray): String =
        Base64.getEncoder().encodeToString(peaks(amplitudes))
}

/**
 * The waveform a card draws, as bar heights from 0.0 to 1.0.
 *
 * Tolerant, because it reads what other clients wrote: a web or iOS note, a
 * note from a later format that widened the column, or an empty string from a
 * server that stored none. Anything that does not decode to at least one byte
 * is a flat low line of [VOICE_NOTE_WAVEFORM_PEAKS] bars, so the card still has
 * a shape and a tap target.
 */
fun decodeWaveform(encoded: String?): FloatArray {
    val flat = FloatArray(VOICE_NOTE_WAVEFORM_PEAKS) { FLAT_BAR }
    if (encoded.isNullOrBlank()) return flat
    val bytes = runCatching { Base64.getDecoder().decode(encoded.trim()) }.getOrNull()
    if (bytes == null || bytes.isEmpty()) return flat
    return FloatArray(bytes.size) { maxOf(FLAT_BAR, (bytes[it].toInt() and 0xFF) / 255f) }
}

/**
 * Fit [peaks] to [bars] bars: the card is as wide as the phone is, and the
 * waveform is always 64 peaks.
 *
 * Narrower than the source, each bar takes the **loudest** peak it covers, so
 * a short loud word does not vanish when the card is small. Wider, the peaks
 * stretch. Both are the same index arithmetic as [PeakNormalizer.peaks].
 */
fun resamplePeaks(peaks: FloatArray, bars: Int): FloatArray {
    if (bars <= 0) return FloatArray(0)
    if (peaks.isEmpty()) return FloatArray(bars) { FLAT_BAR }
    return FloatArray(bars) { bar ->
        val from = (bar.toLong() * peaks.size / bars).toInt()
        val to = maxOf(from + 1, ((bar + 1).toLong() * peaks.size / bars).toInt()).coerceAtMost(peaks.size)
        var peak = 0f
        for (i in from until to) if (peaks[i] > peak) peak = peaks[i]
        peak
    }
}

/** The height of a bar with nothing in it, so silence still draws a line. */
const val FLAT_BAR = 0.08f
