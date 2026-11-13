package gg.pqp.app.ui.components

import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Play's top Android crash in October 2026:
 * `IllegalArgumentException: Padding must be non-negative` at `Avatar.kt:86`.
 * The speaking ring springs back to 0dp with an underdamped spring, dips below
 * zero on the way, and the picture's inset was `padding(ring + ...)`.
 */
class SpeakingRingInsetTest {

    @Test
    fun `the inset is never negative, whatever the spring hands it`() {
        for (ring in listOf((-0.5).dp, (-0.115).dp, (-0.001).dp, 0.dp)) {
            assertEquals("ring $ring", 0.dp, speakingRingInset(ring))
        }
    }

    @Test
    fun `a showing ring keeps the picture clear of it`() {
        assertEquals(4.dp, speakingRingInset(2.5.dp))
        assertEquals(1.6.dp.value, speakingRingInset(0.1.dp).value, 0.0001f)
    }

    /**
     * Why the clamp is needed at all: the exact spring the avatar uses, run
     * from 2.5dp to 0dp, produces values below zero. The clamp is what keeps
     * a bouncy ring safe; this pins that the bounce is real.
     */
    @Test
    fun `the avatar's own spring overshoots below zero when the ring goes away`() {
        val converter: TwoWayConverter<Dp, AnimationVector1D> = Dp.VectorConverter
        val spec: SpringSpec<Dp> = spring(dampingRatio = 0.7f, stiffness = 1400f)
        val vectorized = spec.vectorize(converter)
        val from = converter.convertToVector(2.5.dp)
        val to = converter.convertToVector(0.dp)
        val velocity = AnimationVector1D(0f)
        val duration = vectorized.getDurationNanos(from, to, velocity)
        var lowest = Float.MAX_VALUE
        var t = 0L
        while (t <= duration) {
            lowest = minOf(lowest, vectorized.getValueFromNanos(t, from, to, velocity).value)
            t += 1_000_000L // one millisecond
        }
        assertTrue("the spring should dip below 0dp, lowest was $lowest", lowest < 0f)
        // And the crash path would have handed exactly that to padding.
        assertEquals(0.dp, speakingRingInset(lowest.dp))
    }
}
