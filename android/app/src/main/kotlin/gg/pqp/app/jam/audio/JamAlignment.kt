package gg.pqp.app.jam.audio

import kotlin.math.max
import kotlin.math.roundToLong

/*
 * WHERE EACH STEM STARTS, IN FRAMES. The one place the contract's timeline
 * (`jam.ts`, "THE TIMELINE") becomes arithmetic, so the mixer and its test read
 * the same definition.
 *
 *   a track plays  audio[trimStart, length - trimEnd]
 *   and that slice starts at  offsetMs  on the song timeline
 *
 * The song's zero is not a thing the server fixes ("the engine decides where
 * it zeroes the transport"). This player zeroes it at the EARLIEST start of any
 * stem in the mix, so position 0 is the first sound anybody makes and a track
 * that starts before the song's own zero (a count-in, a negative `offsetMs`) is
 * not cut off. The server's `mixDurationMs` is the same span: latest end minus
 * earliest start. iOS (`JamAlignment.swift`) draws the same line.
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
    /** Where the first played sample sits, relative to the transport's zero. Never negative. */
    val startFrame: Long,
    /** Index of the first played sample in the decoded stem: the start trim. */
    val firstSample: Long,
    /** How many frames play: what is left after both trims. */
    val length: Long,
) {
    val endFrame: Long get() = startFrame + length
}

object JamAlignment {
    /** The transport's zero on the song timeline: the earliest start of any stem. Zero with no stems. */
    fun originMs(stems: List<JamStemSpec>): Double = stems.minOfOrNull { it.offsetMs } ?: 0.0

    /** Whole frames for a span of milliseconds, rounded to nearest. Exact at 48 kHz. */
    fun frames(ms: Double, rate: Int = MIX_RATE): Long = (ms * rate / 1000.0).roundToLong()

    fun ms(frames: Long, rate: Int = MIX_RATE): Double = frames * 1000.0 / rate

    /**
     * The placement of one stem. [fileFrames] is the decoded stem's TRUE length
     * at [rate] (the server's `durationMs` is the recorder's word and rounded to
     * a millisecond; the trim at the tail is measured back from the real end of
     * the file, as the contract says). Null when both trims leave nothing.
     */
    fun place(spec: JamStemSpec, fileFrames: Long, originMs: Double, rate: Int = MIX_RATE): JamPlacement? {
        val firstSample = frames(spec.trimStartMs, rate)
        val trimEnd = frames(spec.trimEndMs, rate)
        val length = fileFrames - firstSample - trimEnd
        if (length <= 0) return null
        return JamPlacement(
            id = spec.id,
            startFrame = frames(spec.offsetMs - originMs, rate),
            firstSample = firstSample,
            length = length,
        )
    }

    /** The mix length in frames: from the earliest start (0) to the latest end. */
    fun durationFrames(placements: List<JamPlacement>): Long = placements.maxOfOrNull { it.endFrame } ?: 0L

    /** The same in milliseconds, for the clock. */
    fun durationMs(placements: List<JamPlacement>, rate: Int = MIX_RATE): Double =
        ms(durationFrames(placements), rate)

    /**
     * File time in milliseconds of a VIDEO at a song position, clamped into the
     * slice the track plays. A take recorded with a camera is cut so its sample
     * 0 is the video's first frame, so file time is the audio's:
     * `song - offset + trimStart`, and one `offsetMs` places both.
     */
    fun videoFileMs(
        songMs: Double,
        offsetMs: Double,
        trimStartMs: Double,
        trimEndMs: Double,
        durationMs: Double,
    ): Double {
        val slice = max(0.0, durationMs - trimStartMs - trimEndMs)
        val into = (songMs - offsetMs).coerceIn(0.0, slice)
        return trimStartMs + into
    }
}
