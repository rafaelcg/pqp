package gg.pqp.app.jam

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/*
 * ADJUSTING A POSTED TAKE: its volume, where it sits in time and what is cut off its ends. The web's
 * `client/src/lib/jam-take-edit.ts` and `jam-clip.ts`, ported with the same ranges, steps and rounding, and read the
 * way the contract reads them (`packages/shared/src/jam.ts`, "THE TIMELINE", and #1595):
 *
 *   offsetMs     the song time of the stored file's FIRST sample, so a nudge adds to it and nothing else;
 *   trimStartMs  the head of the file that is not heard; a trim HIDES audio and never MOVES it;
 *   trimEndMs    the tail that is not heard;
 *   gain         a linear multiplier, 0 to 2.
 *
 * Everything here is arithmetic on plain numbers: the editor reports numbers, the engine plays them, the server
 * stores them, and all three read them through this file, so a drag on the phone and the web's drag on the same
 * recording are the same request. Tested in `JamTrackEditTest`.
 */

/** What the person did to a track so far, laid over what is stored. */
data class TakeEdits(
    val trimStartMs: Double,
    val trimEndMs: Double,
    /** Added to the stored `offsetMs`; the whole recording moves. */
    val nudgeMs: Double,
    val gain: Double,
)

/** The `PATCH /api/jam-tracks/:id` fields an adjustment can change, and only those that did. */
data class TrackPatch(
    val offsetMs: Double? = null,
    val trimStartMs: Double? = null,
    val trimEndMs: Double? = null,
    val gain: Double? = null,
) {
    val isEmpty: Boolean get() = offsetMs == null && trimStartMs == null && trimEndMs == null && gain == null
}

object JamTrackEdit {
    /** The shortest stretch of a take that may stay audible. */
    const val MIN_AUDIBLE_MS = 500.0

    /** How far a nudge may go either way. */
    const val NUDGE_LIMIT_MS = 500.0

    /** The volume's ends and its slider step, in whole percent (the web's slider is 0..200 by 1). */
    const val GAIN_MAX_PERCENT = 200
    const val GAIN_STEP_PERCENT = 1

    /** A change smaller than this is not a change (the web's `0.005`). */
    private const val GAIN_EPSILON = 0.005

    /** `Math.round` of the web: halves go up, and a number that is whole stays. */
    fun round(value: Double): Double = floor(value + 0.5)

    /** A posted track as it is stored: no nudge, its own trims and volume. */
    fun editsFromTrack(track: JamTrack): TakeEdits =
        TakeEdits(trimStartMs = track.trimStartMs, trimEndMs = track.trimEndMs, nudgeMs = 0.0, gain = track.gain)

    /**
     * Move the start trim. The recorded head the engine once hid is not known for a posted track, so the cut may go
     * back to 0; it never leaves less than [MIN_AUDIBLE_MS] to hear (unless the file itself is shorter).
     */
    fun withTrimStart(track: JamTrack, edits: TakeEdits, trimStartMs: Double): TakeEdits {
        val most = track.durationMs - edits.trimEndMs - MIN_AUDIBLE_MS
        return edits.copy(trimStartMs = round(min(max(trimStartMs, 0.0), max(0.0, most))))
    }

    /** Move the end trim (ms hidden at the tail), leaving something to hear. */
    fun withTrimEnd(track: JamTrack, edits: TakeEdits, trimEndMs: Double): TakeEdits {
        val most = track.durationMs - edits.trimStartMs - MIN_AUDIBLE_MS
        return edits.copy(trimEndMs = round(min(max(trimEndMs, 0.0), max(0.0, most))))
    }

    fun withNudge(edits: TakeEdits, nudgeMs: Double): TakeEdits =
        edits.copy(nudgeMs = round(min(max(nudgeMs, -NUDGE_LIMIT_MS), NUDGE_LIMIT_MS)))

    fun withGain(edits: TakeEdits, gain: Double): TakeEdits =
        edits.copy(gain = min(max(gain, 0.0), JamLimits.GAIN_MAX))

    /** The slider's whole percent, as a gain: 100 is 1.0, the web's `value / 100`. */
    fun gainOfPercent(percent: Int): Double = percent.coerceIn(0, GAIN_MAX_PERCENT) / 100.0

    fun percentOfGain(gain: Double): Int = round(gain * 100).toInt().coerceIn(0, GAIN_MAX_PERCENT)

    /** The track with the edits laid on: what the engine plays and what the lane draws while the editor is open. */
    fun placed(track: JamTrack, edits: TakeEdits): JamTrack = track.copy(
        offsetMs = track.offsetMs + edits.nudgeMs,
        trimStartMs = edits.trimStartMs,
        trimEndMs = edits.trimEndMs,
        gain = edits.gain,
    )

    fun isEdited(track: JamTrack, edits: TakeEdits): Boolean = !patchFor(track, edits).isEmpty

    /**
     * The request for what changed, and only that: empty when nothing did. The offset and the trims are whole
     * milliseconds; the gain is rounded to a hundredth, and a difference under half a hundredth is no difference.
     */
    fun patchFor(track: JamTrack, edits: TakeEdits): TrackPatch {
        val offset = round(track.offsetMs + edits.nudgeMs)
        val trimStart = round(edits.trimStartMs)
        val trimEnd = round(edits.trimEndMs)
        return TrackPatch(
            offsetMs = offset.takeIf { it != round(track.offsetMs) },
            trimStartMs = trimStart.takeIf { it != round(track.trimStartMs) },
            trimEndMs = trimEnd.takeIf { it != round(track.trimEndMs) },
            gain = (round(edits.gain * 100) / 100).takeIf { abs(edits.gain - track.gain) > GAIN_EPSILON },
        )
    }

    /** How a nudge reads: the sign and whole milliseconds, "0" for nothing. Whole numbers only: a nudge is rounded. */
    fun wholeMs(ms: Double): Int = round(abs(ms)).toInt()

    /** `volumeDelta` of the web: "+20%", "-75%", null at the recording's own level. */
    fun volumeDelta(gain: Double): String? {
        val percent = round(gain * 100).toInt() - 100
        return if (percent == 0) null else (if (percent > 0) "+" else "-") + abs(percent) + "%"
    }

    /**
     * How tall a take's waveform is drawn for its volume, as a share of its lane: a quiet take is visibly shorter and
     * a silent one is still a line (the web's `levelOfGain`).
     */
    fun levelOfGain(gain: Double): Double = min(1.12, 0.3 + 0.7 * max(0.0, if (gain.isFinite()) gain else 1.0))
}

// --- the editor's picture: which stretch of the song it shows, and the band behind the take ---

/** A stretch of the song, in milliseconds on its timeline. */
data class ClipWindow(val startMs: Double, val endMs: Double)

enum class ClipZoom { Whole, Close }

/** The geometry of the clip editor (the web's `jam-clip.ts`). Everything is song time in milliseconds. */
object JamClip {
    /** Room left on each side of the clip, so a handle is never on the edge. */
    private const val PAD_MS = 400.0

    /** The take's heard stretch on the song, with the edits laid on. */
    fun span(track: JamTrack, edits: TakeEdits): ClipWindow {
        val offset = track.offsetMs + edits.nudgeMs
        return ClipWindow(offset + edits.trimStartMs, offset + track.durationMs - edits.trimEndMs)
    }

    /** The whole recorded file on the song, hidden head and tail included: what the clip draws, handles and all. */
    fun reach(track: JamTrack, nudgeMs: Double): ClipWindow {
        val offset = track.offsetMs + nudgeMs
        return ClipWindow(offset, offset + track.durationMs)
    }

    /**
     * The stretch the editor draws. Whole: the file's full reach at any nudge, so the frame does not move while the
     * clip is dragged. Close: three seconds around where the take starts, where lining up is decided.
     */
    fun window(track: JamTrack, edits: TakeEdits, zoom: ClipZoom): ClipWindow {
        if (zoom == ClipZoom.Close) {
            val start = span(track, edits).startMs
            return ClipWindow(start - 1000, start + 2000)
        }
        return ClipWindow(
            track.offsetMs - JamTrackEdit.NUDGE_LIMIT_MS - PAD_MS,
            track.offsetMs + track.durationMs + JamTrackEdit.NUDGE_LIMIT_MS + PAD_MS,
        )
    }

    /** 0..1 across the window, clamped. */
    fun fraction(window: ClipWindow, ms: Double): Double {
        val length = max(1.0, window.endMs - window.startMs)
        return min(1.0, max(0.0, (ms - window.startMs) / length))
    }

    /** Milliseconds per pixel for a window drawn [width] pixels wide. */
    fun msPerPixel(window: ClipWindow, width: Float): Double = (window.endMs - window.startMs) / max(1f, width)

    /**
     * The band behind the take: [count] heights in 0..1 across the window, each the loudest moment of any lane in
     * that slice (silence where nobody plays). Loudness is per lane, so a quiet bass still shows under a loud drum.
     */
    fun bandEnvelope(lanes: List<JamTrack>, window: ClipWindow, count: Int): List<Float> {
        val out = FloatArray(max(0, count))
        if (count <= 0) return out.toList()
        val slice = (window.endMs - window.startMs) / count
        for (lane in lanes) {
            if (lane.peaks.isEmpty() || lane.durationMs <= 0) continue
            val loudest = lane.peaks.max().takeIf { it > 0 } ?: 1.0
            val audibleFrom = lane.offsetMs + lane.trimStartMs
            val audibleTo = lane.offsetMs + lane.durationMs - lane.trimEndMs
            for (i in 0 until count) {
                val a = max(window.startMs + i * slice, audibleFrom)
                val b = min(window.startMs + (i + 1) * slice, audibleTo)
                if (b <= a) continue
                val from = floor((a - lane.offsetMs) / lane.durationMs * lane.peaks.size).toInt()
                val to = max(from + 1, kotlin.math.ceil((b - lane.offsetMs) / lane.durationMs * lane.peaks.size).toInt())
                var peak = 0.0
                for (j in max(0, from) until min(lane.peaks.size, to)) peak = max(peak, lane.peaks[j])
                out[i] = max(out[i], (peak / loudest).toFloat())
            }
        }
        return out.toList()
    }

    /** The take's own bars, [count] of them across the whole file, scaled so the loudest is 1. */
    fun bars(peaks: List<Double>, count: Int): List<Float> {
        if (count <= 0) return emptyList()
        if (peaks.isEmpty()) return List(count) { 0.3f }
        val out = ArrayList<Float>(count)
        for (i in 0 until count) {
            val a = (i.toLong() * peaks.size / count).toInt()
            val b = max(a + 1, ((i + 1).toLong() * peaks.size / count).toInt())
            var peak = 0.0
            var j = a
            while (j < b && j < peaks.size) {
                peak = max(peak, peaks[j])
                j++
            }
            out += peak.toFloat()
        }
        val loudest = out.max()
        return if (loudest > 0f) out.map { it / loudest } else out
    }
}
