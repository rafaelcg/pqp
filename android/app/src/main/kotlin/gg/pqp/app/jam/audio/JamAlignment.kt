package gg.pqp.app.jam.audio

import kotlin.math.max
import kotlin.math.roundToLong

/*
 * WHERE EACH STEM STARTS, IN FRAMES. The one place a track's numbers become
 * arithmetic, so the mixer, the video, the lanes and their tests read the same
 * definition.
 *
 *   stored sample j of a stem sounds at song time  offsetMs + j / rate
 *   and only the samples in  [trimStartMs, durationMs - trimEndMs)  are heard
 *
 * `offsetMs` is the song time of the stored file's FIRST sample, and a trim
 * hides audio without moving it. That is what the web recorder writes and what
 * the web player plays (`planSegment` in `client/src/lib/jam/timeline.ts`,
 * `docs/JAM_ENGINE.md` "Mapping onto the server's track"), and every stored
 * track was recorded there. A take recorded with a one-bar count-in at 120 BPM
 * is uploaded `offsetMs -2023, trimStartMs 2023`: the count-in stays in the
 * file, hidden, and the first heard sample is song time 0.
 *
 * This file used to read `offsetMs` as "where the first PLAYED sample sits"
 * (the old wording in the header of `jam.ts`), which put every stem
 * `trimStartMs` early: a count-in take two seconds ahead of one without, and
 * any head trim made in the web editor moving the audio by the length trimmed.
 * `JamWebTakeAlignmentTest` plays takes shaped like the web's uploads.
 *
 * The song's zero is not a thing the server fixes. This player zeroes the
 * transport at the EARLIEST HEARD sample of any stem in the mix, so position 0
 * is the first sound anybody makes and a take that starts before the song's own
 * zero (a count-in) is not cut off. iOS (`JamAlignment.swift`) draws the same
 * line.
 *
 * Every stem is decoded and, when its file is not at [MIX_RATE], resampled to
 * [MIX_RATE] before it gets here (`JamResampler`), so all the numbers below are
 * frames of ONE clock. Two stems cannot drift against each other: the mixer
 * sums them at one output frame index.
 */

/** The rate every stem is brought to and the output runs at. 48 frames per millisecond, exactly. */
const val MIX_RATE = 48_000

/** A stem as the engine plays it. Plain numbers, so a plan is testable without a file or a codec. */
data class JamStemSpec(
    val id: String,
    val offsetMs: Double,
    val trimStartMs: Double,
    val trimEndMs: Double,
    /** The track's own gain, 0 to 2. */
    val gain: Float = 1f,
)

/**
 * One stem placed on the transport's timeline, in [MIX_RATE] frames.
 *
 * Output frame `f` (counted from the transport's zero) plays stored sample
 * `firstSample + (f - startFrame)` while `startFrame <= f < startFrame + length`.
 */
data class JamPlacement(
    val id: String,
    /** Where the first HEARD sample sits, relative to the transport's zero. Never negative. */
    val startFrame: Long,
    /** Index of the first heard sample in the decoded stem: the head trim, plus any frames before the transport's zero. */
    val firstSample: Long,
    /** How many frames play: what is left after both trims (and after the transport's zero). */
    val length: Long,
) {
    val endFrame: Long get() = startFrame + length
}

object JamAlignment {
    /** Song time of a stem's first HEARD sample: its file's first sample, plus what the head trim hides. */
    fun heardStartMs(spec: JamStemSpec): Double = spec.offsetMs + max(0.0, spec.trimStartMs)

    /** The transport's zero on the song timeline: the earliest heard sample of any stem. Zero with no stems. */
    fun originMs(stems: List<JamStemSpec>): Double = stems.minOfOrNull(::heardStartMs) ?: 0.0

    /** Whole frames for a span of milliseconds, rounded to nearest. Exact at 48 kHz. */
    fun frames(ms: Double, rate: Int = MIX_RATE): Long = (ms * rate / 1000.0).roundToLong()

    fun ms(frames: Long, rate: Int = MIX_RATE): Double = frames * 1000.0 / rate

    /**
     * The placement of one stem. [fileFrames] is the decoded stem's TRUE length
     * at [rate] (the server's `durationMs` is the recorder's word and rounded to
     * a millisecond; the trim at the tail is measured back from the real end of
     * the file, as the contract says). Null when both trims leave nothing.
     *
     * The web's invariant (`planSegment`), ported: stored frame `j` sounds at
     * `frames(offsetMs - originMs) + j`, so a stem is placed by ONE rounding of
     * its offset and the trims only decide which frames are heard.
     */
    fun place(spec: JamStemSpec, fileFrames: Long, originMs: Double, rate: Int = MIX_RATE): JamPlacement? {
        var firstSample = frames(max(0.0, spec.trimStartMs), rate)
        val endSample = fileFrames - frames(max(0.0, spec.trimEndMs), rate)
        if (endSample <= firstSample) return null
        // Where the file's frame 0 falls, in frames after the transport's zero (negative: before it).
        val fileStart = frames(spec.offsetMs - originMs, rate)
        var startFrame = fileStart + firstSample
        // The transport's zero is the earliest heard sample, but two roundings can put a stem a frame short of it.
        if (startFrame < 0) {
            firstSample -= startFrame
            startFrame = 0
        }
        if (endSample <= firstSample) return null
        return JamPlacement(
            id = spec.id,
            startFrame = startFrame,
            firstSample = firstSample,
            length = endSample - firstSample,
        )
    }

    /** The mix length in frames: from the earliest heard sample (0) to the latest. */
    fun durationFrames(placements: List<JamPlacement>): Long = placements.maxOfOrNull { it.endFrame } ?: 0L

    /** The same in milliseconds, for the clock. */
    fun durationMs(placements: List<JamPlacement>, rate: Int = MIX_RATE): Double =
        ms(durationFrames(placements), rate)

    /**
     * File time in milliseconds of a VIDEO at a song position, clamped into the
     * slice the track plays. A take recorded with a camera is cut so its sample
     * 0 is the video's first frame, so the video's file time is the audio's:
     * `song - offset` (the web's `attachVideo` does the same), and one `offsetMs`
     * places both. The trims only bound it: never into the hidden head, never
     * past the hidden tail.
     */
    fun videoFileMs(
        songMs: Double,
        offsetMs: Double,
        trimStartMs: Double,
        trimEndMs: Double,
        durationMs: Double,
    ): Double {
        val from = max(0.0, trimStartMs)
        val to = max(from, durationMs - max(0.0, trimEndMs))
        return (songMs - offsetMs).coerceIn(from, to)
    }
}
