package gg.pqp.app.jam.audio

import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.tanh

/**
 * THE ENGINE'S HEART: every stem summed into ONE output buffer by one frame
 * counter.
 *
 * WHY A MIXER OF OUR OWN. The point of a jam is that stems recorded by
 * different people line up to the sample. Several `MediaPlayer` or `ExoPlayer`
 * instances "started at the same time" do not: each has its own codec, buffer
 * and clock, start-up differs by tens of milliseconds and varies run to run,
 * and nothing ties their drift together. A single `AudioTrack` fed by this
 * mixer has one clock by construction: output frame `f` is the sum of every
 * stem's sample at `f`, so the relative position of two stems is whatever the
 * placement arithmetic (`JamAlignment`) says and nothing else can move it.
 * Seeking and pausing cannot de-sync anything either, because there is nothing
 * to re-sync: the next buffer is simply rendered from the new frame.
 *
 * Pure: no Android type, so `JamMixerTest` renders it against impulse stems and
 * reads where each lands. The thing that talks to the hardware is
 * [JamPlayer], which only calls [render] and writes the result.
 *
 * Levels move by a short linear ramp across a buffer rather than jumping, so
 * muting a loud stem is not a click.
 */
class JamMixer {
    private class Stem(
        val placement: JamPlacement,
        val pcm: PcmSource,
    ) {
        /** Linear gain applied last buffer, ramped toward [target] across the next one. */
        @Volatile var target: Float = 1f
        var current: Float = 1f
    }

    @Volatile private var stems: List<Stem> = emptyList()

    /** The levels survive a reload of the stems (a stem keeps its mute when another is added). */
    private val levels = ConcurrentHashMap<String, Float>()

    @Volatile var durationFrames: Long = 0
        private set

    /** Replace what plays. Called off the render thread; the next buffer sees the new set whole. */
    fun setStems(next: List<Pair<JamPlacement, PcmSource>>) {
        val old = stems.associateBy { it.placement.id }
        stems = next.map { (placement, pcm) ->
            Stem(placement, pcm).also { stem ->
                val level = levels[placement.id] ?: 1f
                stem.target = level
                // A stem that was already playing keeps its place in the ramp; a new one starts at its level.
                stem.current = old[placement.id]?.current ?: level
            }
        }
        durationFrames = JamAlignment.durationFrames(next.map { it.first })
    }

    /** The linear level of one stem: track gain times volume, 0 when it is not audible. */
    fun setLevel(id: String, level: Float) {
        levels[id] = level
        stems.firstOrNull { it.placement.id == id }?.target = level
    }

    /** Jump every level to its target at once (before the first buffer after a load, so a muted stem never blips). */
    fun snapLevels() {
        stems.forEach { it.current = it.target }
    }

    /**
     * Renders [frames] frames starting at timeline frame [position] into [out]
     * as interleaved stereo (the same mono mix on both channels). [scratch] is a
     * reusable buffer of at least [frames] samples and [acc] one of at least
     * [frames] floats, so the render thread allocates nothing.
     */
    fun render(
        position: Long,
        out: ShortArray,
        frames: Int,
        masterLevel: Float = 1f,
        scratch: ShortArray = ShortArray(frames),
        acc: FloatArray = FloatArray(frames),
    ) {
        java.util.Arrays.fill(acc, 0, frames, 0f)
        for (stem in stems) {
            val p = stem.placement
            val from = max(position, p.startFrame)
            val to = min(position + frames, p.endFrame)
            val ramp = stem.current != stem.target
            val start = stem.current
            val end = stem.target
            if (to > from) {
                val count = (to - from).toInt()
                stem.pcm.read(p.firstSample + (from - p.startFrame), scratch, 0, count)
                val offset = (from - position).toInt()
                for (i in 0 until count) {
                    val gain = if (ramp) start + (end - start) * ((offset + i + 1).toFloat() / frames) else end
                    acc[offset + i] += scratch[i] * (1f / 32768f) * gain
                }
            }
            stem.current = end
        }
        for (i in 0 until frames) {
            val s = toPcm16(soften(acc[i] * masterLevel))
            out[2 * i] = s
            out[2 * i + 1] = s
        }
    }

    companion object {
        /**
         * Identity below the knee, so one stem at unity comes out sample for
         * sample, and a smooth ceiling above it so a loud mix saturates instead
         * of wrapping.
         */
        internal fun soften(x: Float): Float {
            val magnitude = abs(x)
            if (magnitude <= KNEE) return x
            val over = tanh((magnitude - KNEE) / (1f - KNEE)) * (1f - KNEE)
            return if (x < 0) -(KNEE + over) else KNEE + over
        }

        internal fun toPcm16(x: Float): Short {
            val v = Math.round(x * 32768f)
            return v.coerceIn(-32768, 32767).toShort()
        }

        private const val KNEE = 0.9f
    }
}
