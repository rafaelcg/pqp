package gg.pqp.app.jam.record

import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.MIX_RATE

/**
 * What the output stream plays while a take is recorded, as a function of the
 * stream frame, so it is checked on the JVM against a real mixer
 * (`JamTakeRendererTest`) and the hardware class only has to ask for the next
 * block.
 *
 * The stream is: a short pre-roll of silence, the count-in clicks, then the
 * band. [p0] is the stream frame at which the band's transport frame 0 plays,
 * which is exactly the number `JamTakePlacement.rawOffsetMs` needs: song time
 * `fromMs` leaves the output at stream frame `p0`.
 */
interface OutputSource {
    /** Fills [out] (interleaved stereo, [frames] frames) with the stream starting at stream frame [startFrame]. */
    fun render(startFrame: Long, out: ShortArray, frames: Int)
}

class JamTakeRenderer(
    private val mixer: JamMixer,
    /** Stream frame of the band's transport frame 0. */
    val p0: Long,
    /** Stream frames at which a count-in click starts, and whether it is the accent. */
    private val clicks: List<Pair<Long, Boolean>>,
    rate: Int = MIX_RATE,
) : OutputSource {
    private val accent = toShorts(JamSignals.click(rate, true))
    private val plain = toShorts(JamSignals.click(rate, false))
    private val scratch = ShortArray(CHUNK)
    private val acc = FloatArray(CHUNK)

    override fun render(startFrame: Long, out: ShortArray, frames: Int) {
        require(frames <= CHUNK) { "block too large" }
        // The mixer is asked for a position that is negative until the band starts: a stem never starts before 0,
        // so those frames come out as silence and no special case is needed at the boundary.
        mixer.render(startFrame - p0, out, frames, 1f, scratch, acc)
        for ((at, isAccent) in clicks) {
            val sound = if (isAccent) accent else plain
            val from = maxOf(startFrame, at)
            val to = minOf(startFrame + frames, at + sound.size)
            for (f in from until to) {
                val i = (f - startFrame).toInt()
                val v = sound[(f - at).toInt()].toInt()
                out[2 * i] = (out[2 * i] + v).coerceIn(-32768, 32767).toShort()
                out[2 * i + 1] = (out[2 * i + 1] + v).coerceIn(-32768, 32767).toShort()
            }
        }
    }

    companion object {
        const val CHUNK = 1024

        /** Silence ahead of the first click, so the stream is running before anything has to be heard. */
        const val PRE_ROLL_MS = 150

        private fun toShorts(sound: FloatArray) = ShortArray(sound.size) { (sound[it] * 0.55f * 32767f).toInt().toShort() }

        /** The count-in's clicks and where the band starts: [bars] bars of [beatsPerBar] beats at [bpm]. */
        fun plan(bars: Int, beatsPerBar: Int, bpm: Int, rate: Int = MIX_RATE): CountIn {
            val pre = (PRE_ROLL_MS * rate / 1000L)
            val beat = Math.round(60.0 / bpm * rate)
            val total = bars * beatsPerBar
            val clicks = (0 until total).map { (pre + it * beat) to (it % beatsPerBar == 0) }
            return CountIn(clicks, pre + total * beat, total)
        }
    }

    /** The count-in: click frames, the frame the band starts at, and how many clicks. */
    data class CountIn(val clicks: List<Pair<Long, Boolean>>, val p0: Long, val beats: Int)
}

/** A calibration signal: mono samples played from stream frame 0, silence after. */
class SignalSource(private val samples: FloatArray) : OutputSource {
    override fun render(startFrame: Long, out: ShortArray, frames: Int) {
        for (i in 0 until frames) {
            val at = startFrame + i
            val v = if (at in samples.indices) (samples[at.toInt()] * 32767f).toInt().coerceIn(-32768, 32767).toShort() else 0
            out[2 * i] = v
            out[2 * i + 1] = v
        }
    }
}
