package gg.pqp.app.jam

import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.JamPlayer
import gg.pqp.app.jam.audio.JamSink
import gg.pqp.app.jam.audio.JamStemSpec
import gg.pqp.app.jam.audio.ShortArrayPcm
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The transport against a sink that "plays" instantly: what the audio thread
 * asks the mixer for and writes, in what order, from where. Play renders from
 * the start, a seek restarts rendering at the new frame (nothing is re-synced
 * because nothing can be out of step), pause stops writing, and the end is
 * reported once and leaves the transport at zero.
 */
class JamPlayerTransportTest {

    private class FakeSink(
        /** `AudioTrack` does not promise a flush puts its counters back to zero; false is the platform that keeps counting. */
        private val resetsOnFlush: Boolean = true,
    ) : JamSink {
        val written = ArrayList<Short>()
        @Volatile var flushes = 0
        @Volatile var started = false
        @Volatile var failing = false
        @Volatile private var head = 0L

        /** Takes at most 1024 samples a call and takes a millisecond over it, so playback is not instant. */
        override fun write(buffer: ShortArray, offset: Int, length: Int): Int {
            if (failing) return -6 // AudioTrack.ERROR_DEAD_OBJECT
            val taken = minOf(length, 1024)
            synchronized(written) { for (i in 0 until taken) written += buffer[offset + i] }
            head += taken / 2
            Thread.sleep(1)
            return taken
        }

        override fun start() { started = true }
        override fun pause() { started = false }
        override fun flush() {
            flushes += 1
            if (resetsOnFlush) head = 0
        }
        override fun headFrames() = head
        override fun timestamp(): Pair<Long, Long>? = null
        override fun release() = Unit

        fun leftChannel(): List<Short> = synchronized(written) { written.filterIndexed { i, _ -> i % 2 == 0 } }
    }

    private fun player(sink: FakeSink, impulses: List<Int>, length: Int): JamPlayer {
        val player = JamPlayer(JamMixer(), sinkFactory = { sink })
        val samples = ShortArray(length).also { s -> impulses.forEach { s[it] = 12_000 } }
        val spec = JamStemSpec("a", 0.0, 0.0, 0.0)
        val pcm = ShortArrayPcm(samples)
        player.load(listOf(checkNotNull(JamAlignment.place(spec, pcm.frames, 0.0)) to pcm))
        return player
    }

    private fun waitFor(timeoutMs: Long = 3000, condition: () -> Boolean) {
        val until = System.nanoTime() + timeoutMs * 1_000_000
        while (!condition()) {
            check(System.nanoTime() < until) { "timed out" }
            Thread.sleep(2)
        }
    }

    @Test
    fun `play renders from the start in order and the end is reported once`() {
        val sink = FakeSink()
        val player = player(sink, impulses = listOf(0, 999, 4_999), length = 5_000)
        val ended = CountDownLatch(1)
        val job = Thread { runBlocking { player.ended.first(); ended.countDown() } }.also { it.start() }
        Thread.sleep(50)
        player.play()
        assertTrue(ended.await(3, TimeUnit.SECONDS))
        job.join(500)

        val left = sink.leftChannel()
        val at = left.indices.filter { left[it].toInt() != 0 }
        assertEquals(listOf(0, 999, 4_999), at)
        // The transport is back at zero and paused.
        assertFalse(player.playing.value)
        assertEquals(0.0, player.positionMs(), 0.0)
        player.release()
    }

    @Test
    fun `a seek restarts rendering at the new frame`() {
        val sink = FakeSink()
        // Impulses at 1000 and 9000 of a 10000-frame stem. Seek to 8000 frames (a sixth of a second) and play.
        val player = player(sink, impulses = listOf(1_000, 9_000), length = 10_000)
        player.seekTo(JamAlignment.ms(8_000))
        assertEquals(JamAlignment.ms(8_000), player.positionMs(), 1e-6)
        player.play()
        waitFor { !player.playing.value }

        val left = sink.leftChannel()
        val at = left.indices.filter { left[it].toInt() != 0 }
        // Only the impulse after the seek is rendered, and it is 1000 frames after the start of what was written.
        assertEquals(listOf(1_000), at)
        player.release()
    }

    @Test
    fun `pause stops writing and play resumes from the same place`() {
        val sink = FakeSink()
        // A long stem so there is something to pause in.
        val player = player(sink, impulses = listOf(0), length = 480_000)
        player.play()
        waitFor { sink.leftChannel().size > 2_000 }
        player.pause()
        Thread.sleep(80)
        val atPause = sink.leftChannel().size
        Thread.sleep(80)
        assertEquals("nothing written while paused", atPause, sink.leftChannel().size)
        assertFalse(player.playing.value)
        // The sink itself was paused (an AudioTrack left "started" underruns in silence and keeps a clock running).
        assertFalse("sink paused", sink.started)
        val heldAt = player.positionMs()
        Thread.sleep(60)
        assertEquals("the position holds while paused", heldAt, player.positionMs(), 1e-6)
        player.play()
        waitFor { sink.leftChannel().size > atPause + 2_000 }
        // Contiguous: the only impulse is still the first sample.
        val left = sink.leftChannel()
        assertEquals(listOf(0), left.indices.filter { left[it].toInt() != 0 })
        player.release()
    }

    @Test
    fun `a seek after playing is not thrown off by a sink that keeps counting through a flush`() {
        val sink = FakeSink(resetsOnFlush = false)
        // 4 s of stem so there is room to play a while and then jump back.
        val player = player(sink, impulses = listOf(1_000, 100_000), length = 192_000)
        player.play()
        waitFor { sink.leftChannel().size > 20_000 }
        player.pause()
        Thread.sleep(40)
        // Jump back to frame 90000: the position must read the new place, not the old count added to it.
        player.seekTo(JamAlignment.ms(90_000))
        assertEquals(JamAlignment.ms(90_000), player.positionMs(), 1e-6)
        val before = sink.leftChannel().size
        player.play()
        waitFor { sink.leftChannel().size > before + 2_000 }
        val position = player.positionMs()
        assertTrue("position $position ms is near 90000 frames", position in JamAlignment.ms(90_000)..JamAlignment.ms(90_000 + 30_000))
        // And the song still ends where it should: the impulse at 100000 is rendered once after the seek.
        waitFor(6000) { !player.playing.value }
        val tail = sink.leftChannel().drop(before)
        assertEquals(listOf(10_000), tail.indices.filter { tail[it].toInt() != 0 })
        player.release()
    }

    /**
     * A sink with a real clock: what has been written plays out at 48 kHz from `start()`, `headFrames()` is how much
     * of it has been heard, `timestamp()` pairs that with the time it was heard, and a flush either puts the count
     * back to zero or does not (the platform makes no promise). The thing the transport has to get right is that
     * the reported position follows it at exactly 1x, before and after a seek.
     */
    private class ClockSink(private val resetsOnFlush: Boolean) : JamSink {
        private var written = 0L
        private var counted = 0L
        private var startedAt = 0L
        @Volatile private var started = false

        @Synchronized private fun heard(): Long {
            if (!started) return counted
            val elapsed = (System.nanoTime() - startedAt) * 48_000 / 1_000_000_000L
            return minOf(written, counted + elapsed)
        }

        @Synchronized override fun write(buffer: ShortArray, offset: Int, length: Int): Int {
            // Room for about 100 ms ahead of what has been heard, like a real track buffer.
            val ahead = written - heard()
            if (ahead > 4_800) return 0
            written += length / 2
            return length
        }

        @Synchronized override fun start() {
            started = true
            startedAt = System.nanoTime()
        }

        @Synchronized override fun pause() {
            counted = heard()
            started = false
        }

        @Synchronized override fun flush() {
            if (resetsOnFlush) {
                counted = 0
                written = 0
            } else {
                written = counted
            }
        }

        @Synchronized override fun headFrames(): Long = heard()

        @Synchronized override fun timestamp(): Pair<Long, Long>? =
            if (started) heard() to System.nanoTime() else null

        override fun release() = Unit
    }

    @Test
    fun `after a seek to T while playing the position starts at T and runs at 1x, whatever a flush does to the counters`() {
        for (resets in listOf(true, false)) {
            val player = JamPlayer(JamMixer(), sinkFactory = { ClockSink(resets) })
            val samples = ShortArray(48_000 * 20)
            val pcm = ShortArrayPcm(samples)
            player.load(listOf(checkNotNull(JamAlignment.place(JamStemSpec("a", 0.0, 0.0, 0.0), pcm.frames, 0.0)) to pcm))
            player.play()
            Thread.sleep(500)
            // Before the seek it is at 1x from zero.
            val before = player.positionMs()
            assertEquals("resets=$resets before the seek", 500.0, before, 60.0)

            player.seekTo(10_000.0)
            // The moment after: at T, not at the old position, not at zero.
            assertEquals("resets=$resets just after the seek", 10_000.0, player.positionMs(), 40.0)
            Thread.sleep(600)
            val after = player.positionMs()
            // 600 ms later: T plus 600 ms (give the output's own start-up its room), never the old count carried over.
            assertEquals("resets=$resets 600 ms after the seek", 10_600.0, after, 90.0)
            val rate = (player.positionMs().let { p -> Thread.sleep(400); player.positionMs() - p }) / 400.0
            assertEquals("resets=$resets runs at 1x", 1.0, rate, 0.12)
            player.release()
        }
    }

    @Test
    fun `a sink that cannot be built, or dies mid-song, stops the transport and a later play starts again`() {
        var builds = 0
        var broken = true
        val sink = FakeSink()
        val player = JamPlayer(JamMixer(), sinkFactory = {
            builds += 1
            if (broken) error("no audio device")
            sink
        })
        val pcm = ShortArrayPcm(ShortArray(48_000 * 2).also { it[0] = 9_000 })
        player.load(listOf(checkNotNull(JamAlignment.place(JamStemSpec("a", 0.0, 0.0, 0.0), pcm.frames, 0.0)) to pcm))
        val failed = CountDownLatch(1)
        Thread { runBlocking { player.failures.first(); failed.countDown() } }.start()
        Thread.sleep(50)
        player.play()
        assertTrue(failed.await(3, TimeUnit.SECONDS))
        assertFalse("the transport says it is stopped", player.playing.value)

        // The device comes back: play() builds a new sink and plays.
        broken = false
        player.play()
        waitFor { sink.leftChannel().size > 2_000 }
        assertTrue(builds >= 2)
        // It dies mid-song: the writes error, the transport stops and says so.
        val failedAgain = CountDownLatch(1)
        Thread { runBlocking { player.failures.first(); failedAgain.countDown() } }.start()
        Thread.sleep(50)
        sink.failing = true
        assertTrue(failedAgain.await(3, TimeUnit.SECONDS))
        assertFalse(player.playing.value)
        player.release()
    }

    @Test
    fun `an empty song cannot play`() {
        val sink = FakeSink()
        val player = JamPlayer(JamMixer(), sinkFactory = { sink })
        player.play()
        assertFalse(player.playing.value)
        player.release()
    }
}
