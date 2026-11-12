package gg.pqp.app.jam.record

import android.media.AudioDeviceInfo
import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.ShortArrayPcm
import java.io.File
import java.nio.file.Files
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The route rules, the stream the studio plays, what is read off a take, and the take on disk. */
class JamRecordSupportTest {

    // --- the route ---

    private val speaker = Device(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "Speaker")
    private val mic = Device(AudioDeviceInfo.TYPE_BUILTIN_MIC, "Microphone")
    private val wired = Device(AudioDeviceInfo.TYPE_WIRED_HEADSET, "Headset")
    private val wiredMic = Device(AudioDeviceInfo.TYPE_WIRED_HEADSET, "Headset mic")
    private val buds = Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "Galaxy Buds")
    private val usb = Device(AudioDeviceInfo.TYPE_USB_HEADSET, "USB audio")

    @Test
    fun `the speaker bleeds into the microphone and headphones do not`() {
        assertTrue(JamRoute(mic, speaker, MIX_RATE).bleeds)
        assertFalse(JamRoute(mic, wired, MIX_RATE).bleeds)
        assertFalse(JamRoute(mic, buds, MIX_RATE).bleeds)
        assertEquals(RouteKind.Bluetooth, JamRoute(mic, buds, MIX_RATE).outputKind)
        assertEquals(RouteKind.Wired, JamRoute(wiredMic, usb, MIX_RATE).outputKind)
        // Nothing known is treated as the worst: a warning is cheaper than a take full of band.
        assertEquals(RouteKind.Other, JamRoute(null, null, MIX_RATE).outputKind)
    }

    @Test
    fun `wired beats Bluetooth beats the speaker, and a headset brings its own microphone`() {
        val preview = JamRoutes.preview(listOf(speaker, buds, wired), listOf(mic, wiredMic), MIX_RATE)
        assertEquals(wired, preview.output)
        assertEquals(wiredMic, preview.input)
        val bt = JamRoutes.preview(listOf(speaker, buds), listOf(mic), MIX_RATE)
        assertEquals(buds, bt.output)
        // Bluetooth in media mode has no microphone path: the phone's is used.
        assertEquals(mic, bt.input)
        assertEquals(speaker, JamRoutes.preview(listOf(speaker), listOf(mic), MIX_RATE).output)
    }

    @Test
    fun `a calibration belongs to a route and not to another`() {
        val a = JamRoute(mic, buds, MIX_RATE).key
        val b = JamRoute(mic, Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "Other Buds"), MIX_RATE).key
        val c = JamRoute(mic, speaker, MIX_RATE).key
        val d = JamRoute(mic, buds, 44_100).key
        assertEquals(4, setOf(a, b, c, d).size)
        // Case and spacing in a device's name do not make a new route.
        assertEquals(a, JamRoute(mic, Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "  galaxy   BUDS "), MIX_RATE).key)
    }

    // --- the stream ---

    @Test
    fun `the count-in is clicks on the beat, the band starts on the frame the plan says, and a click is never in the band`() {
        val plan = JamTakeRenderer.plan(bars = 1, beatsPerBar = 4, bpm = 120)
        val beat = MIX_RATE / 2
        val pre = JamTakeRenderer.PRE_ROLL_MS * MIX_RATE / 1000
        assertEquals(List(4) { (pre + it * beat).toLong() to (it == 0) }, plan.clicks)
        assertEquals((pre + 4 * beat).toLong(), plan.p0)
        assertEquals(4, plan.beats)
        // No count-in: just the pre-roll.
        val none = JamTakeRenderer.plan(0, 4, 120)
        assertTrue(none.clicks.isEmpty())
        assertEquals(pre.toLong(), none.p0)

        // A band that is one impulse at transport frame 1000: it must be at stream frame p0 + 1000.
        val samples = ShortArray(5000).also { it[1000] = 22_000 }
        val mixer = JamMixer()
        mixer.setStems(listOf(checkNotNull(JamAlignment.place(gg.pqp.app.jam.audio.JamStemSpec("b", 0.0, 0.0, 0.0), 5000, 0.0)) to ShortArrayPcm(samples)))
        val world = SimulatedWorld()
        val out = world.render(JamTakeRenderer(mixer, plan.p0, plan.clicks), (plan.p0 + 6000).toInt())
        val impulse = out.indices.first { it >= plan.p0 && abs(out[it].toInt()) > 15_000 }
        assertEquals(plan.p0 + 1000, impulse.toLong())
        // Each click is audible at its frame and the stream is silent before the first.
        for ((at, _) in plan.clicks) assertTrue((at until at + 400).any { abs(out[it.toInt()].toInt()) > 3000 })
        assertTrue((0 until pre).all { out[it].toInt() == 0 })
    }

    @Test
    fun `a stream rendered in blocks of any size is the same stream`() {
        val plan = JamTakeRenderer.plan(1, 4, 100)
        val mixer = JamMixer()
        val r = JamTakeRenderer(mixer, plan.p0, plan.clicks)
        val whole = SimulatedWorld().render(r, 80_000)
        val parts = ShortArray(80_000)
        val block = ShortArray(2048)
        var at = 0
        val sizes = listOf(1, 7, 333, 1000, 1024)
        var k = 0
        while (at < 80_000) {
            val n = minOf(sizes[k++ % sizes.size], 80_000 - at)
            r.render(at.toLong(), block, n)
            for (i in 0 until n) parts[at + i] = block[2 * i]
            at += n
        }
        assertTrue(whole.contentEquals(parts))
    }

    // --- what is read off a take ---

    @Test
    fun `peaks are the loudest sample of each slice of the whole take, in 0 to 1`() {
        val s = ShortArray(40_000)
        s[100] = 16_384
        s[39_999] = -32_768
        val peaks = JamTakeAudio.peaks(ShortArrayPcm(s), 0, s.size.toLong(), 400)
        assertEquals(400, peaks.size)
        assertEquals(0.5, peaks[1], 0.0)
        assertEquals(1.0, peaks[399], 0.0)
        assertEquals(0.0, peaks[200], 0.0)
        assertEquals(emptyList<Double>(), JamTakeAudio.peaks(ShortArrayPcm(s), 0, 0))
        // Never more than the server takes, and never more buckets than samples.
        assertEquals(400, JamTakeAudio.peaks(ShortArrayPcm(s), 0, s.size.toLong(), 5000).size)
        assertEquals(3, JamTakeAudio.peaks(ShortArrayPcm(s), 0, 3, 400).size)
    }

    @Test
    fun `a take that is a flat line is flagged, a quiet one is not, and the hidden head does not count`() {
        val flat = ShortArray(MIX_RATE * 4)
        assertTrue(JamTakeAudio.isSilent(ShortArrayPcm(flat), 0, flat.size.toLong(), 0))
        val quiet = ShortArray(MIX_RATE * 4) { if (it % 1000 == 0) 900 else 0 } // about -31 dBFS
        assertFalse(JamTakeAudio.isSilent(ShortArrayPcm(quiet), 0, quiet.size.toLong(), 0))
        // Clicks of the count-in leak into a microphone: loud in the head, nothing after.
        val leaked = ShortArray(MIX_RATE * 4).also { for (i in 0 until MIX_RATE step 4000) it[i] = 12_000 }
        assertFalse(JamTakeAudio.isSilent(ShortArrayPcm(leaked), 0, leaked.size.toLong(), 0))
        assertTrue(JamTakeAudio.isSilent(ShortArrayPcm(leaked), 0, leaked.size.toLong(), MIX_RATE.toLong() + 10))
    }

    @Test
    fun `the offset view starts where the dropped samples end`() {
        val s = ShortArray(100) { it.toShort() }
        val view = OffsetPcm(ShortArrayPcm(s), 19)
        assertEquals(81L, view.frames)
        val out = ShortArray(3)
        view.read(0, out, 0, 3)
        assertEquals(listOf<Short>(19, 20, 21), out.toList())
    }

    // --- the take on disk ---

    private fun dir(): File = Files.createTempDirectory("jam-takes").toFile()

    private fun saved(id: String, song: String?, at: Long = 1L, draft: NewSongDraft? = null) = SavedTake(
        id = id, channelId = "chan", songId = song, draft = draft, instrument = "guitar",
        offsetMs = -2023.0, trimStartMs = 2023.0, durationMs = 5000.0, dropFrames = 19, frames = 240_000,
        peaks = listOf(0.1, 0.9), nudgeMs = -20, correctionMs = 12.5, routeKey = "r", savedAt = at,
    )

    @Test
    fun `a saved take comes back whole, with its nudge, and is found for its song`() {
        val store = JamTakeStore(dir())
        store.newCapture("a").writeBytes(ByteArray(10))
        store.save(saved("a", "song-1"))
        val back = store.load("a")!!
        assertEquals(-2023.0, back.offsetMs, 0.0)
        assertEquals(-2043.0, back.placedOffsetMs, 0.0)
        assertEquals(listOf(0.1, 0.9), back.peaks)
        assertEquals("a", store.pending("chan", "song-1")!!.id)
        assertNull(store.pending("chan", "song-2"))
        assertNull(store.pending("other", "song-1"))
    }

    @Test
    fun `a take for a song that does not exist yet is found by its channel, with its draft`() {
        val store = JamTakeStore(dir())
        store.newCapture("n").writeBytes(ByteArray(10))
        store.save(saved("n", null, draft = NewSongDraft("In Bloom", "Nirvana", "wanted", listOf("bass"), "nonce-1")))
        val found = store.pending("chan", null)!!
        assertEquals("In Bloom", found.draft!!.title)
        assertEquals("nonce-1", found.draft!!.nonce)
        assertEquals(listOf("bass"), found.draft!!.wantedInstruments)
    }

    @Test
    fun `a take with no audio file is not a take, and deleting removes everything`() {
        val store = JamTakeStore(dir())
        store.save(saved("x", "s"))
        assertNull("metadata without its audio", store.load("x"))
        store.newCapture("y").writeBytes(ByteArray(10))
        store.save(saved("y", "s"))
        store.flac("y").writeBytes(ByteArray(3))
        assertNotEquals(null, store.load("y"))
        store.delete("y")
        assertNull(store.load("y"))
        assertFalse(store.pcm("y").exists())
        assertFalse(store.flac("y").exists())
    }

    @Test
    fun `files nothing refers to are swept and a real take is not`() {
        val d = dir()
        val store = JamTakeStore(d)
        store.newCapture("live").writeBytes(ByteArray(10))
        store.save(saved("live", "s"))
        // A recording the process died in the middle of: audio and no metadata.
        store.newCapture("died").writeBytes(ByteArray(10))
        store.flac("gone").writeBytes(ByteArray(3))
        store.sweepOrphans()
        assertTrue(store.pcm("live").exists())
        assertFalse(store.pcm("died").exists())
        assertFalse(store.flac("gone").exists())
    }

    @Test
    fun `the newest waiting take comes first`() {
        val store = JamTakeStore(dir())
        for ((id, at) in listOf("old" to 1L, "new" to 9L, "mid" to 5L)) {
            store.newCapture(id).writeBytes(ByteArray(2))
            store.save(saved(id, "s$id", at))
        }
        assertEquals(listOf("new", "mid", "old"), store.all().map { it.id })
    }
}
