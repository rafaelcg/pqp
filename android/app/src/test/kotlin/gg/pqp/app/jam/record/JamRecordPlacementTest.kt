package gg.pqp.app.jam.record

import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.JamStemSpec
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.ShortArrayPcm
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE POINT OF THE FEATURE, PROVEN WITHOUT A PHONE: a part recorded N ms into
 * the song is stored so that it plays back at N ms, here and on the web.
 *
 * [SimulatedWorld] stands in for the hardware: an output and an input with
 * their own latency, two streams that start apart, and timestamps that are
 * WRONG by a constant (the thing a platform gets wrong and the calibration
 * measures). Everything between the streams and the stored numbers is the real
 * code: the count-in and the band through the real renderer and mixer, the
 * calibration through the real cross-correlation, the placement through the
 * real arithmetic, and the playback through `JamAlignment` and `JamMixer`, the
 * engine every stored take goes through.
 *
 * The "player" plays along perfectly: every click of the band they hear, they
 * play back the instant they hear it. So the take's click for song time S must
 * come out at S, and the test reads where it comes out of the MIXER, never the
 * stored number.
 */
class JamRecordPlacementTest {
    private val rate = MIX_RATE

    /** A band of one stem: one-sample clicks at these song times (ms), 20 s long, placed at offset 0. */
    private val clicksMs = listOf(500.0, 2500.0, 7000.0, 12_345.0)
    private val bandSamples = ShortArray(20 * rate).also { s -> clicksMs.forEach { s[(it * rate / 1000).toInt()] = 20_000 } }
    private val bandSpec = JamStemSpec("band", 0.0, 0.0, 0.0)

    /** Calibrate in [world] by loopback: the real signal, the real analysis. */
    private fun calibrate(world: SimulatedWorld): LatencyResult {
        val ref = JamSignals.sweep(rate, amplitude = 0.7f)
        val first = (JamLatency.LOOPBACK_FIRST_MS / 1000 * rate).toInt()
        val period = (JamLatency.PULSE_PERIOD_MS / 1000 * rate).toInt()
        val at = List(10) { first + it * period }
        val signal = JamSignals.pulseTrain(first + 10 * period, ref, at)
        val streamFrames = signal.size + rate
        val out = world.render(SignalSource(signal), streamFrames)
        val capture = world.capture(out, streamFrames, acoustic = true)
        val aP = JamTakePlacement.anchorNs(world.outputStamps(streamFrames.toLong()), rate, at[5].toLong())!!
        val aC = JamTakePlacement.anchorNs(world.captureStamps(streamFrames.toLong()), rate, at[5].toLong())!!
        val expected = at.map { ((aP - aC) / 1e9 + it.toDouble() / rate) * rate }
        return JamLatency.analyseLoopback(FloatArray(capture.size) { capture[it] / 32768f }, expected, ref, rate, ClockMode.TIMESTAMPS, 1L)
    }

    private class Placed(val offsetMs: Double, val trimStartMs: Double, val durationMs: Double, val dropFrames: Int, val take: ShortArray, val fromMs: Double)

    /** Record the band in [world] with a [bars]-bar count-in, the correction [correctionMs], and place the take. */
    private fun record(world: SimulatedWorld, correctionMs: Double, bars: Int = 1): Placed {
        val mixer = JamMixer()
        val origin = JamAlignment.originMs(listOf(bandSpec))
        mixer.setStems(listOf(checkNotNull(JamAlignment.place(bandSpec, bandSamples.size.toLong(), origin)) to ShortArrayPcm(bandSamples)))
        val plan = JamTakeRenderer.plan(bars, 4, 100)
        val renderer = JamTakeRenderer(mixer, plan.p0, plan.clicks)
        val streamFrames = (plan.p0 + 16L * rate).toInt()
        val captureFrames = streamFrames - 5 * rate / 10
        val out = world.render(renderer, streamFrames)
        // The person's echo: they play whatever they hear, with no speaker-to-microphone trip.
        val capture = world.capture(out, captureFrames, acoustic = false)
        val aP = JamTakePlacement.anchorNs(world.outputStamps(streamFrames.toLong()), rate, plan.p0)!!
        val aC = JamTakePlacement.anchorNs(world.captureStamps(captureFrames.toLong()), rate, 0)!!
        val raw = JamTakePlacement.rawOffsetMs(origin, plan.p0, aP, aC, correctionMs, rate)
        val placed = JamTakePlacement.finish(captureFrames.toLong(), origin, raw, rate)
        val kept = capture.copyOfRange(placed.dropFrames, capture.size)
        return Placed(placed.offsetMs, placed.trimStartMs, placed.durationMs, placed.dropFrames, kept, origin)
    }

    /** Where the mixer plays each of the take's band clicks, as song time in ms (the mix's zero is song time [origin]). */
    private fun heardSongTimes(p: Placed): List<Double> {
        val takeSpec = JamStemSpec("take", p.offsetMs, p.trimStartMs, 0.0)
        val origin = JamAlignment.originMs(listOf(bandSpec, takeSpec))
        val placement = checkNotNull(JamAlignment.place(takeSpec, p.take.size.toLong(), origin))
        val mixer = JamMixer()
        mixer.setStems(listOf(placement to ShortArrayPcm(p.take)))
        val total = 17 * rate
        val out = ShortArray(total)
        val block = ShortArray(2048)
        var at = 0
        while (at < total) {
            val n = minOf(1024, total - at)
            mixer.render(at.toLong(), block, n, 1f, ShortArray(1024), FloatArray(1024))
            for (i in 0 until n) out[at + i] = block[2 * i]
            at += n
        }
        // The click is the loudest sample of each run above the threshold (the count-in's own clicks leak back but are hidden by the trim).
        val clicks = ArrayList<Double>()
        var i = 0
        while (i < out.size) {
            if (abs(out[i].toInt()) > 5000) {
                var best = i
                var j = i
                while (j < out.size && j - i < 200) {
                    if (abs(out[j].toInt()) > abs(out[best].toInt())) best = j
                    j++
                }
                clicks += origin + best * 1000.0 / rate
                i = j + 200
            } else {
                i++
            }
        }
        return clicks
    }

    @Test
    fun `the calibration finds what the platform's timestamps get wrong`() {
        val world = SimulatedWorld()
        val result = calibrate(world)
        println("RESULT calibration: ${result.correctionMs} ms (truth ${world.trueCorrectionMs}), ${result.confidence}, spread ${result.spreadMs} ms, ${result.accepted}/${result.played} pulses")
        assertTrue(result.usable)
        assertEquals(world.trueCorrectionMs, result.correctionMs, 0.35)
    }

    @Test
    fun `a take recorded over the band plays back where it was played, with a count-in`() {
        val world = SimulatedWorld()
        val correction = calibrate(world).correctionMs
        val placed = record(world, correction)
        val heard = heardSongTimes(placed)
        println("RESULT take offset ${placed.offsetMs} trimStart ${placed.trimStartMs} duration ${placed.durationMs}; heard clicks at $heard (band: $clicksMs)")
        assertEquals("every band click is in the take", clicksMs.size, heard.size)
        for ((h, want) in heard.zip(clicksMs)) {
            // The speaker-to-microphone trip is in the calibration and not in a player, so the take is up to that much early: well under a millisecond.
            assertEquals("click for song time $want", want, h, 1.0)
        }
    }

    @Test
    fun `the count-in sits before the song's zero and is hidden by the head trim, as the web stores it`() {
        val world = SimulatedWorld()
        val placed = record(world, calibrate(world).correctionMs)
        // offsetMs is the song time of the stored file's FIRST sample: before the count-in's first click, so negative.
        assertTrue("offset ${placed.offsetMs} is before the count-in", placed.offsetMs < -JamTakeRenderer.PRE_ROLL_MS - 2300.0)
        // The head trim hides exactly what was recorded before the band started: from - offset.
        assertEquals(placed.fromMs - placed.offsetMs, placed.trimStartMs, 1e-9)
        assertEquals(placed.offsetMs, Math.rint(placed.offsetMs), 0.0)
    }

    @Test
    fun `without the calibration the same take is early or late by exactly what the platform got wrong`() {
        val world = SimulatedWorld()
        val heard = heardSongTimes(record(world, correctionMs = 0.0))
        // -20.5 ms of stamp error is what the calibration would have removed: the proof that it is what moves the take.
        for ((h, want) in heard.zip(clicksMs)) assertEquals(want + world.trueCorrectionMs, h, 1.0)
    }

    @Test
    fun `a different phone lands in the same place once it is calibrated`() {
        val phones = listOf(
            SimulatedWorld(outputLatencyMs = 8.0, inputLatencyMs = 6.0, startSkewMs = 3.0, outputStampErrorMs = 0.0, inputStampErrorMs = 0.0),
            SimulatedWorld(outputLatencyMs = 48.0, inputLatencyMs = 31.0, startSkewMs = 40.0, outputStampErrorMs = -22.0, inputStampErrorMs = 35.0, jitterMs = 0.6),
            SimulatedWorld(outputLatencyMs = 130.0, inputLatencyMs = 20.0, startSkewMs = 70.0, outputStampErrorMs = 60.0, inputStampErrorMs = -45.0),
        )
        for (world in phones) {
            val calibration = calibrate(world)
            assertTrue("calibration usable: $calibration", calibration.usable)
            val heard = heardSongTimes(record(world, calibration.correctionMs))
            println("RESULT phone (out ${world.outputLatencyMs}, in ${world.inputLatencyMs}, stamp errors ${world.outputStampErrorMs}/${world.inputStampErrorMs}): correction ${calibration.correctionMs}, worst error ${heard.zip(clicksMs).maxOf { (h, w) -> abs(h - w) }} ms")
            for ((h, want) in heard.zip(clicksMs)) assertEquals(want, h, 1.0)
        }
    }

    @Test
    fun `it is the same number the web's formula gives for the same round trip`() {
        val world = SimulatedWorld(outputStampErrorMs = 0.0, inputStampErrorMs = 0.0, jitterMs = 0.0, acousticMs = 0.0)
        val plan = JamTakeRenderer.plan(1, 4, 100)
        val streamFrames = plan.p0.toInt() + 4 * rate
        val aP = JamTakePlacement.anchorNs(world.outputStamps(streamFrames.toLong()), rate, plan.p0)!!
        val aC = JamTakePlacement.anchorNs(world.captureStamps(streamFrames.toLong()), rate, 0)!!
        val mine = JamTakePlacement.rawOffsetMs(0.0, plan.p0, aP, aC, 0.0, rate)
        // `placement.ts`: from + (captureStartFrame - backingStartFrame) / sr * 1000 - roundTripMs, in ONE context's frames.
        // Here the capture started `startSkew` before the stream, and the round trip is what a web loopback would read.
        val roundTrip = world.outputLatencyMs + world.inputLatencyMs
        val captureStartFrame = -world.startSkewMs / 1000 * rate
        val web = 0.0 + (captureStartFrame - plan.p0) / rate * 1000 - roundTrip
        assertEquals(web, mine, 0.01)
    }

    @Test
    fun `the worked example of the contract is stored the way the web stores it`() {
        // jam.ts: a take with a one-bar count-in (2000 ms at 120 BPM) and a 23 ms round trip is uploaded
        // `offsetMs -2023, trimStartMs 2023, trimEndMs 0, durationMs 62023`.
        val placed = JamTakePlacement.finish(62_023L * rate / 1000, 0.0, -2023.0, rate)
        assertEquals(-2023.0, placed.offsetMs, 0.0)
        assertEquals(2023.0, placed.trimStartMs, 0.0)
        assertEquals(62_023.0, placed.durationMs, 0.0)
        assertEquals(0, placed.dropFrames)
    }

    @Test
    fun `an offset that is not a whole millisecond is made whole by dropping fewer than one millisecond of samples`() {
        val (offset, drop) = JamTakePlacement.wholeMillisecond(-2023.4, rate)
        assertEquals(-2023, offset)
        // The first stored sample was at -2023.4; dropping 19 frames moves it to -2023.0 and the take loses nothing audible.
        assertEquals(19, drop)
        val (exact, none) = JamTakePlacement.wholeMillisecond(-137.0, rate)
        assertEquals(-137, exact)
        assertEquals(0, none)
        for (fraction in listOf(0.01, 0.25, 0.5, 0.75, 0.99)) {
            val raw = -500.0 - fraction
            val (o, d) = JamTakePlacement.wholeMillisecond(raw, rate)
            assertTrue("drops under a millisecond of samples", d in 0..(rate / 1000))
            assertEquals("the first kept sample is at the whole millisecond", o.toDouble(), raw + d * 1000.0 / rate, 0.02)
        }
    }

    @Test
    fun `a take that starts after the band has trims nothing and a take with no count-in trims the lead-in`() {
        // The microphone opened 300 ms AFTER the band started: nothing of the first 300 ms was recorded, nothing to hide.
        val late = JamTakePlacement.finish(10 * rate.toLong(), 0.0, 300.0, rate)
        assertEquals(0.0, late.trimStartMs, 0.0)
        assertEquals(300.0, late.offsetMs, 0.0)
        // Opened 137 ms before it: those 137 ms are the lead-in and stay in the file, hidden.
        val early = JamTakePlacement.finish(10 * rate.toLong(), 0.0, -137.0, rate)
        assertEquals(137.0, early.trimStartMs, 0.0)
    }

    @Test
    fun `the clock fit ignores a late poll and a stream that stuttered earlier`() {
        val base = 9_000_000_000L
        val line = (0 until 40).map { TimestampSample(it * 4800L, base + it * 4800L * 1_000_000_000L / rate) }.toMutableList()
        // A poll that was served 6 ms late, near the frame we ask about, must not move the answer.
        line[20] = line[20].copy(nanos = line[20].nanos + 6_000_000)
        // And an early stretch from before an under-run, on a line 30 ms off, is far from the frame we ask about.
        for (i in 0 until 5) line[i] = line[i].copy(nanos = line[i].nanos + 30_000_000)
        val anchor = JamTakePlacement.anchorNs(line, rate, aroundFrame = 4800L * 20)!!
        assertEquals(base.toDouble(), anchor, 1.0)
        assertEquals(null, JamTakePlacement.anchorNs(emptyList(), rate, 0))
        assertNotNull(JamTakePlacement.driftPpm(0.0, 3_000_000.0, 60.0))
        assertEquals(50.0, JamTakePlacement.driftPpm(0.0, 3_000_000.0, 60.0)!!, 1e-6)
    }
}
