package gg.pqp.app.jam.record

import android.media.AudioDeviceInfo
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamTrack
import gg.pqp.app.jam.JamTrackWithSong
import gg.pqp.app.jam.audio.JamFocusPolicy
import gg.pqp.app.jam.audio.JamPlayer
import gg.pqp.app.jam.audio.JamSink
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.PcmSource
import gg.pqp.app.jam.audio.ShortArrayPcm
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlin.math.abs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The studio's state machine against fakes: the rules that keep a take from
 * being lost or placed wrong, in the order a person meets them. The hardware is
 * [FakeDuplex] running [SimulatedWorld], so the take that comes out of "stop" is
 * placed by the real arithmetic from real timestamps with real errors in them.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class JamStudioViewModelTest {
    private val rate = MIX_RATE
    private lateinit var dir: File
    private lateinit var takes: JamTakeStore
    private lateinit var kv: MapKv
    private lateinit var dispatcher: TestDispatcher
    private val world = SimulatedWorld()
    private val route = JamRoute(Device(AudioDeviceInfo.TYPE_BUILTIN_MIC, "Microphone"), Device(AudioDeviceInfo.TYPE_WIRED_HEADSET, "Headset"), rate)
    private val callActive = MutableStateFlow(false)

    private class MapKv : KeyValue {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String) {
            map[key] = value
        }

        override fun remove(key: String) {
            map.remove(key)
        }
    }

    private class FakeSink : JamSink {
        override fun write(buffer: ShortArray, offset: Int, length: Int) = length
        override fun start() = Unit
        override fun pause() = Unit
        override fun flush() = Unit
        override fun headFrames() = 0L
        override fun timestamp(): Pair<Long, Long>? = null
        override fun release() = Unit
    }

    private class FakeFocus(val onChange: (JamFocusPolicy.Change) -> Unit, val onNoisy: () -> Unit) : StudioFocus {
        var held = false
        var grant = true
        override fun acquire(): Boolean {
            held = grant
            return grant
        }

        override fun release() {
            held = false
        }
    }

    private class FakePost : JamPostBackend {
        val calls = mutableListOf<String>()
        var failNext: Throwable? = null
        var createdSong: String = "song-new"
        var tickets = 0
        var lastTrack: AddJamTrackRequest? = null
        var lastTrackSong: String? = null
        var putBytes: ByteArray? = null
        var putTicket: JamUploadTicket? = null
        var putCount = 0
        var claimFailures = 0

        private fun maybeFail() {
            failNext?.let {
                failNext = null
                throw it
            }
        }

        override suspend fun createSong(channelId: String, body: CreateJamSongRequest): JamSongSummary {
            calls += "createSong:${body.title}:${body.nonce}"
            maybeFail()
            return JamSongSummary(id = createdSong, channelId = channelId, title = body.title)
        }

        override suspend fun ticket(songId: String, contentType: String, byteSize: Long): JamUploadTicket {
            calls += "ticket:$songId:$contentType:$byteSize"
            maybeFail()
            tickets += 1
            return JamUploadTicket("upload-$tickets", "https://bucket.example/put", "")
        }

        override suspend fun put(ticket: JamUploadTicket, file: File, contentType: String, onProgress: (sent: Long) -> Unit) {
            calls += "put:${ticket.uploadId}:$contentType"
            maybeFail()
            putCount += 1
            putTicket = ticket
            putBytes = file.readBytes()
            onProgress(file.length())
        }

        override suspend fun addTrack(songId: String, body: AddJamTrackRequest): JamTrackWithSong {
            calls += "addTrack:$songId:${body.audioUploadId}"
            maybeFail()
            lastTrack = body
            lastTrackSong = songId
            val song = JamSongSummary(id = songId, channelId = "chan", title = "t")
            return JamTrackWithSong(JamTrack(id = "track-1", songId = songId), song)
        }

        override suspend fun deleteSongIfEmpty(songId: String) {
            calls += "deleteIfEmpty:$songId"
        }
    }

    private class FakeRoutes(var route: JamRoute) : JamRouteProbe {
        override fun preview() = route
        override fun watch(onChange: () -> Unit): () -> Unit = {}
    }

    private val post = FakePost()
    private val foci = mutableListOf<FakeFocus>()
    private val duplexes = mutableListOf<FakeDuplex>()
    private var micFailure: DuplexFailure? = null

    /** How much capture a recording yields: by default the whole simulated stream. */
    private var captureFrames: Int? = null

    @Before
    fun setUp() {
        dispatcher = StandardTestDispatcher()
        Dispatchers.setMain(dispatcher)
        dir = Files.createTempDirectory("jam-studio").toFile()
        takes = JamTakeStore(File(dir, "takes"))
        kv = MapKv()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private val clicksMs = listOf(500.0, 2500.0, 7000.0, 12_345.0)
    private fun bandStem(): BackingStem {
        val samples = ShortArray(20 * rate).also { s -> clicksMs.forEach { s[(it * rate / 1000).toInt()] = 20_000 } }
        val track = JamTrack(
            id = "band", songId = "song-1", authorId = "other", authorName = "duda", instrument = JamInstrument.Drums,
            durationMs = 20_000.0, inMix = true, peaks = List(100) { 0.4 },
        )
        return BackingStem(track, ShortArrayPcm(samples) as PcmSource, samples.size.toLong())
    }

    private fun launch(songId: String? = "song-1", withBand: Boolean = true, draft: NewSongDraft? = null) = JamStudioLaunch(
        channelId = "chan",
        songId = songId,
        songTitle = "Song",
        draft = draft,
        backing = if (withBand) listOf(bandStem()) else emptyList(),
        addable = JamInstrument.entries,
        initialInstrument = JamInstrument.Guitar,
    )

    private fun model(target: JamStudioLaunch = launch(), routes: FakeRoutes = FakeRoutes(route), backend: JamPostBackend = post): JamStudioViewModel {
        val streamFrames = JamTakeRenderer.plan(1, 4, 100).p0.toInt() + 16 * rate
        return JamStudioViewModel(
            target = target,
            post = backend,
            takes = takes,
            latency = JamLatencyStore(kv),
            routes = routes,
            newDuplex = { _ ->
                FakeDuplex(world, route, streamFrames, captureFrames ?: (streamFrames - rate / 2)).also {
                    it.failure = micFailure
                    duplexes += it
                }
            },
            focusFactory = { change, noisy -> FakeFocus(change, noisy).also { foci += it } },
            callActive = callActive,
            newPlayer = { JamPlayer(sinkFactory = { FakeSink() }) },
            io = dispatcher,
            default = dispatcher,
            now = { 1_000L },
            newId = { "take-${takes.all().size + duplexes.size}" },
            openPcm = { gg.pqp.app.jam.audio.MappedPcm(it) },
        )
    }

    private fun calibrated() {
        JamLatencyStore(kv).save(route.key, JamLatency.manual(world.trueCorrectionMs, ClockMode.TIMESTAMPS, 1L))
    }

    /** Where the first band click is in the saved take, as song time: what has to be 500 ms. */
    private fun firstClickSongMs(take: SavedTake): Double {
        val bytes = takes.pcm(take.id).readBytes()
        val n = bytes.size / 2
        var click = -1
        for (i in take.dropFrames until n) {
            val v = ((bytes[2 * i].toInt() and 0xFF) or (bytes[2 * i + 1].toInt() shl 8)).toShort().toInt()
            // The band's clicks are 20000; the count-in's are quieter.
            if (abs(v) > 15_000) {
                click = i
                break
            }
        }
        assertTrue("a band click is in the take", click >= 0)
        return take.offsetMs + (click - take.dropFrames) * 1000.0 / rate
    }

    private fun JamStudioViewModel.ready(): JamStudioViewModel {
        onMicPermission(true)
        return this
    }

    // --- the things in the way ---

    @Test
    fun `in a call the studio says so and records nothing, and does not touch the call's audio`() = runTest(dispatcher) {
        calibrated()
        callActive.value = true
        val vm = model().ready()
        advanceUntilIdle()
        assertEquals(StudioBlock.InCall, vm.ui.value.block)
        assertFalse(vm.ui.value.canRecord)
        vm.record()
        vm.measure(MeasureMethod.Loopback)
        advanceUntilIdle()
        assertTrue("no stream was opened", duplexes.isEmpty())
        assertTrue("no focus was taken from the call", foci.none { it.held })
        // The call ends: the block lifts by itself.
        callActive.value = false
        advanceUntilIdle()
        assertNull(vm.ui.value.block)
        assertTrue(vm.ui.value.canRecord)
    }

    @Test
    fun `no microphone permission is a block, and granting it lifts it`() = runTest(dispatcher) {
        calibrated()
        val vm = model()
        vm.onMicPermission(false)
        assertEquals(StudioBlock.MicDenied, vm.ui.value.block)
        assertFalse(vm.ui.value.canRecord)
        vm.record()
        assertTrue(duplexes.isEmpty())
        vm.onMicPermission(true)
        assertNull(vm.ui.value.block)
        assertTrue(vm.ui.value.canRecord)
    }

    @Test
    fun `a route nobody has measured cannot record, a measured one can, and a different route is asked again`() = runTest(dispatcher) {
        val routes = FakeRoutes(route)
        val vm = model(routes = routes).ready()
        assertNull(vm.ui.value.calibration)
        assertFalse(vm.ui.value.canRecord)
        vm.record()
        assertTrue("no record without a calibration", duplexes.isEmpty())
        calibrated()
        vm.refreshRoute()
        assertTrue(vm.ui.value.canRecord)
        // The headphones change: the stored measurement is for the old route.
        routes.route = JamRoute(route.input, Device(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, "Buds"), rate)
        vm.refreshRoute()
        assertNull(vm.ui.value.calibration)
        assertFalse(vm.ui.value.canRecord)
        assertTrue(vm.ui.value.bluetooth)
    }

    @Test
    fun `measuring by loopback stores the correction for this route and unlocks recording`() = runTest(dispatcher) {
        val vm = model().ready()
        vm.measure(MeasureMethod.Loopback)
        advanceUntilIdle()
        val ui = vm.ui.value
        println("RESULT studio measured ${ui.calibration}")
        assertEquals(StudioPhase.Setup, ui.phase)
        assertNotNull(ui.calibration)
        assertEquals(world.trueCorrectionMs, ui.calibration!!.correctionMs, 0.35)
        assertTrue(ui.canRecord)
        assertEquals(StudioNotice.MeasureSaved, ui.notice)
        // It is on the phone's storage, under the route: a new studio finds it.
        assertEquals(1, JamLatencyStore(kv).get(route.key).size)
        assertFalse("the measurement's capture file is gone", takes.pcm("measure").exists())
        assertTrue("the focus was given back", foci.none { it.held })
    }

    @Test
    fun `a microphone that cannot be opened is a block, not a crash`() = runTest(dispatcher) {
        calibrated()
        micFailure = DuplexFailure.MicBusy
        val vm = model().ready()
        vm.record()
        assertEquals(StudioBlock.MicBusy, vm.ui.value.block)
        assertEquals(StudioPhase.Setup, vm.ui.value.phase)
        assertTrue(foci.none { it.held })
    }

    // --- recording ---

    @Test
    fun `stopping a take places it on the song and saves it before anything else`() = runTest(dispatcher) {
        calibrated()
        val vm = model().ready()
        vm.record()
        assertEquals(StudioPhase.Countdown, vm.ui.value.phase)
        vm.stop()
        advanceUntilIdle()
        val ui = vm.ui.value
        assertEquals(StudioPhase.Review, ui.phase)
        val take = ui.take!!
        assertNotNull("on disk", takes.load(take.id))
        val songMs = firstClickSongMs(take)
        println("RESULT studio take: offset ${take.offsetMs}, trimStart ${take.trimStartMs}, the band's 500 ms click is stored at song time $songMs")
        assertEquals(500.0, songMs, 1.0)
        assertTrue(take.offsetMs < 0)
        assertEquals(0.0, take.offsetMs + take.trimStartMs, 1e-9)
        assertEquals("the instrument is what was picked", "guitar", take.instrument)
        assertEquals(400, take.peaks.size)
        // Stopping was the gesture: the band starts again by itself so the take is heard with it, and holds the focus to do so.
        assertTrue("the review plays with the band by itself", ui.playing)
        assertTrue(foci.last().held)
        assertTrue(ui.lanes.any { it.mine })
        assertEquals(1, ui.lanes.count { !it.mine })
    }

    @Test
    fun `a first take of a new song records with no band at all`() = runTest(dispatcher) {
        calibrated()
        val draft = NewSongDraft("In Bloom", "Nirvana", "open", emptyList(), "n-1")
        val vm = model(launch(songId = null, withBand = false, draft = draft)).ready()
        vm.record()
        vm.stop()
        advanceUntilIdle()
        val take = vm.ui.value.take!!
        assertNull(take.songId)
        assertEquals("In Bloom", take.draft!!.title)
        // No band: the count-in is the whole lead-in, and the take's heard part starts at song time 0.
        assertEquals(0.0, take.offsetMs + take.trimStartMs, 1e-9)
    }

    @Test
    fun `focus lost while recording ends the take and keeps what was played`() = runTest(dispatcher) {
        calibrated()
        val vm = model().ready()
        vm.record()
        foci.last().onChange(JamFocusPolicy.Change.LossTransient)
        advanceUntilIdle()
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        assertEquals(CutReason.Focus, vm.ui.value.cut)
        assertNotNull(takes.load(vm.ui.value.take!!.id))
    }

    @Test
    fun `a call that connects under a recording stops it and keeps the take`() = runTest(dispatcher) {
        calibrated()
        val vm = model().ready()
        advanceUntilIdle()
        vm.record()
        callActive.value = true
        advanceUntilIdle()
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        assertEquals(CutReason.Call, vm.ui.value.cut)
        assertTrue("and does not start the band under the call", !vm.ui.value.playing)
        assertEquals(StudioBlock.InCall, vm.ui.value.block)
    }

    @Test
    fun `headphones pulled and the app left both end the take and keep it`() = runTest(dispatcher) {
        calibrated()
        val vm = model().ready()
        vm.record()
        foci.last().onNoisy()
        advanceUntilIdle()
        assertEquals(CutReason.Unplugged, vm.ui.value.cut)
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        vm.recordAgain()
        vm.record()
        vm.onBackgrounded()
        advanceUntilIdle()
        assertEquals(CutReason.Background, vm.ui.value.cut)
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
    }

    @Test
    fun `a take cut short before a second of it can be heard is dropped and the person is told`() = runTest(dispatcher) {
        calibrated()
        captureFrames = JamTakeRenderer.plan(1, 4, 100).p0.toInt() + 12_000 // a quarter of a second into the band
        val vm = model().ready()
        vm.record()
        foci.last().onChange(JamFocusPolicy.Change.Loss)
        advanceUntilIdle()
        assertEquals(StudioPhase.Setup, vm.ui.value.phase)
        assertEquals(StudioNotice.CutEmpty, vm.ui.value.notice)
        assertTrue("nothing is left on disk", takes.all().isEmpty())
    }

    @Test
    fun `leaving in the middle of a recording keeps nothing that was cancelled and stops the streams`() = runTest(dispatcher) {
        calibrated()
        val vm = model().ready()
        vm.record()
        assertEquals(StudioJamRisk.Recording, risk(vm))
        vm.discardAndClose()
        advanceUntilIdle()
        assertTrue(duplexes.single().cancelled)
        assertTrue(takes.all().isEmpty())
    }

    private enum class StudioJamRisk { None, Recording, UnsentTake }

    private fun risk(vm: JamStudioViewModel) = when (vm.leaveRisk()) {
        JamStudioViewModel.LeaveRisk.None -> StudioJamRisk.None
        JamStudioViewModel.LeaveRisk.Recording -> StudioJamRisk.Recording
        JamStudioViewModel.LeaveRisk.UnsentTake -> StudioJamRisk.UnsentTake
    }

    // --- review ---

    private fun recordedReview(target: JamStudioLaunch = launch(), backend: JamPostBackend = post): JamStudioViewModel {
        calibrated()
        val vm = model(target, backend = backend).ready()
        vm.record()
        vm.stop()
        dispatcher.scheduler.advanceUntilIdle()
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        return vm
    }

    @Test
    fun `nudging moves the whole take, is clamped, is saved, and moves nothing else`() = runTest(dispatcher) {
        val vm = recordedReview()
        val before = vm.ui.value.take!!
        vm.nudge(10)
        vm.nudge(10)
        vm.nudge(-50)
        assertEquals(-30, vm.ui.value.take!!.nudgeMs)
        assertEquals(before.offsetMs - 30, vm.ui.value.take!!.placedOffsetMs, 0.0)
        assertEquals("the head trim stays where the recording put it", before.trimStartMs, vm.ui.value.take!!.trimStartMs, 0.0)
        assertEquals("and it is on disk", -30, takes.load(before.id)!!.nudgeMs)
        repeat(100) { vm.nudge(100) }
        assertEquals(JamTakeEdit.NUDGE_LIMIT_MS, vm.ui.value.take!!.nudgeMs)
        vm.resetNudge()
        assertEquals(0, vm.ui.value.take!!.nudgeMs)
    }

    @Test
    fun `keeping a nudge turns it into this route's correction for the next take`() = runTest(dispatcher) {
        val vm = recordedReview()
        val c = vm.ui.value.take!!.correctionMs
        vm.nudge(20)
        vm.keepNudgeForRoute()
        val stored = JamLatency.choose(JamLatencyStore(kv).get(route.key), ClockMode.TIMESTAMPS)!!
        // The take was heard 20 ms late and moved 20 later to fix it, so the correction moves the other way by as much.
        assertEquals(LatencyMethod.MANUAL, stored.method)
        assertEquals(c - 20, stored.correctionMs, 1e-9)
    }

    @Test
    fun `a take that survived the process dying opens in the review, not in a blank studio`() = runTest(dispatcher) {
        val first = recordedReview()
        val id = first.ui.value.take!!.id
        first.keepAndClose()
        assertNotNull("kept on disk", takes.load(id))
        val again = model().ready()
        advanceUntilIdle()
        assertEquals(StudioPhase.Review, again.ui.value.phase)
        assertEquals(id, again.ui.value.take!!.id)
        assertEquals(StudioNotice.Restored, again.ui.value.notice)
        // For the same song only: another song's studio starts clean.
        val other = model(launch(songId = "song-2")).ready()
        assertEquals(StudioPhase.Setup, other.ui.value.phase)
    }

    @Test
    fun `recording again throws the old take away`() = runTest(dispatcher) {
        val vm = recordedReview()
        val id = vm.ui.value.take!!.id
        vm.recordAgain()
        assertEquals(StudioPhase.Setup, vm.ui.value.phase)
        assertNull(vm.ui.value.take)
        assertNull(takes.load(id))
        assertFalse(takes.pcm(id).exists())
    }

    @Test
    fun `leaving a reviewed take asks, keeping it leaves it on disk, discarding removes it`() = runTest(dispatcher) {
        val vm = recordedReview()
        assertEquals(StudioJamRisk.UnsentTake, risk(vm))
        val id = vm.ui.value.take!!.id
        vm.keepAndClose()
        assertNotNull(takes.load(id))
        val again = model().ready()
        advanceUntilIdle()
        again.discardAndClose()
        assertNull(takes.load(id))
    }

    // --- sending ---

    @Test
    fun `sending a take over an existing song uploads FLAC and claims it with the placement the contract defines`() = runTest(dispatcher) {
        val vm = recordedReview()
        vm.nudge(20)
        val take = vm.ui.value.take!!
        vm.send()
        advanceUntilIdle()
        assertEquals(StudioPhase.Done, vm.ui.value.phase)
        val claimed = post.lastTrack!!
        println("RESULT claim: offset ${claimed.offsetMs} trimStart ${claimed.trimStartMs} trimEnd ${claimed.trimEndMs} duration ${claimed.durationMs} gain ${claimed.gain} peaks ${claimed.peaks.size}")
        assertEquals("song-1", post.lastTrackSong)
        assertEquals("guitar", claimed.instrument)
        assertEquals("the take's offset plus the nudge", take.offsetMs + 20, claimed.offsetMs, 0.0)
        assertEquals(take.trimStartMs.toInt().toDouble(), claimed.trimStartMs, 0.0)
        assertEquals(0.0, claimed.trimEndMs, 0.0)
        assertEquals(1.0, claimed.gain, 0.0)
        assertEquals(Math.round(take.durationMs).toInt(), claimed.durationMs)
        assertTrue(claimed.peaks.size in 1..400)
        // The bytes are a FLAC of exactly the take's length, and the ticket asked for exactly that many.
        val bytes = post.putBytes!!
        assertEquals("fLaC", String(bytes, 0, 4))
        assertTrue(post.calls.any { it == "ticket:song-1:audio/flac:${bytes.size}" })
        assertTrue(post.calls.any { it == "put:upload-1:audio/flac" })
        // Sent: nothing left behind.
        assertNull(takes.load(take.id))
        assertFalse(takes.flac(take.id).exists())
        assertEquals("song-1", vm.ui.value.sentSongId)
    }

    @Test
    fun `a first take creates the song once, with its nonce, and then goes into it`() = runTest(dispatcher) {
        val draft = NewSongDraft("In Bloom", null, "wanted", listOf("bass"), "nonce-9")
        val vm = recordedReview(launch(songId = null, withBand = false, draft = draft))
        vm.send()
        advanceUntilIdle()
        assertEquals(StudioPhase.Done, vm.ui.value.phase)
        assertEquals(listOf("createSong:In Bloom:nonce-9"), post.calls.filter { it.startsWith("createSong") })
        assertEquals("song-new", post.lastTrackSong)
    }

    @Test
    fun `a failed send keeps the take and says why, and sending again works`() = runTest(dispatcher) {
        val vm = recordedReview()
        post.failNext = IOException("offline")
        vm.send()
        advanceUntilIdle()
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        assertEquals(PostFailure.Network, vm.ui.value.postFailure)
        assertFalse("a connection that dropped is worth another try", vm.ui.value.postFatal)
        assertNotNull("the take is still on disk", takes.load(vm.ui.value.take!!.id))
        vm.send()
        advanceUntilIdle()
        assertEquals(StudioPhase.Done, vm.ui.value.phase)
        assertNull(takes.load(vm.ui.value.take!!.id))
    }

    /** A backend whose claim fails once AFTER the file went up, as when the answer is lost. */
    private class LosesTheClaimOnce(private val inner: FakePost) : JamPostBackend by inner {
        override suspend fun addTrack(songId: String, body: AddJamTrackRequest): JamTrackWithSong {
            inner.calls += "claim:${body.audioUploadId}"
            if (inner.claimFailures-- > 0) throw IOException("lost the answer")
            return inner.addTrack(songId, body)
        }
    }

    @Test
    fun `the claim failing after the upload is retried with the same upload, so the file goes once and cannot become two tracks`() = runTest(dispatcher) {
        post.claimFailures = 1
        val vm = recordedReview(backend = LosesTheClaimOnce(post))
        vm.send()
        advanceUntilIdle()
        assertEquals(PostFailure.Network, vm.ui.value.postFailure)
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        assertEquals(1, post.putCount)
        vm.send()
        advanceUntilIdle()
        assertEquals(StudioPhase.Done, vm.ui.value.phase)
        assertEquals("the file was sent once", 1, post.putCount)
        assertEquals("and one ticket was asked for", 1, post.tickets)
        assertEquals("the claim was made twice, naming the same upload both times", listOf("claim:upload-1", "claim:upload-1"), post.calls.filter { it.startsWith("claim:") })
    }

    @Test
    fun `a song closed while the take waited can never be sent to, and the take is still there to keep or discard`() = runTest(dispatcher) {
        val vm = recordedReview()
        post.failNext = gg.pqp.app.core.ApiException(403, "jam_song_closed")
        vm.send()
        advanceUntilIdle()
        assertEquals(PostFailure.Closed, vm.ui.value.postFailure)
        assertTrue(vm.ui.value.postFatal)
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        assertNotNull(takes.load(vm.ui.value.take!!.id))
    }

    @Test
    fun `every refusal the server can give is told apart`() {
        assertEquals(PostFailure.Gone, postFailureOf(gg.pqp.app.core.ApiException(404, "not_found")))
        assertEquals(PostFailure.RateLimited, postFailureOf(gg.pqp.app.core.ApiException(429, "jam_rate_limited")))
        assertEquals(PostFailure.InstrumentNotWanted, postFailureOf(gg.pqp.app.core.ApiException(403, "jam_instrument_not_wanted")))
        assertEquals(PostFailure.SongFull, postFailureOf(gg.pqp.app.core.ApiException(409, "jam_song_full")))
        assertEquals(PostFailure.AuthorLimit, postFailureOf(gg.pqp.app.core.ApiException(409, "jam_author_track_limit")))
        assertEquals(PostFailure.Off, postFailureOf(gg.pqp.app.core.ApiException(403, "jam_channels_off")))
        assertEquals(PostFailure.StorageOff, postFailureOf(gg.pqp.app.core.ApiException(503, "jam_storage_off")))
        assertEquals(PostFailure.TooLarge, postFailureOf(gg.pqp.app.core.ApiException(413, null)))
        assertEquals(PostFailure.Network, postFailureOf(IOException("boom")))
        assertEquals(PostFailure.Other, postFailureOf(IllegalStateException()))
    }

    /** A backend whose upload ticket always fails: the song gets made and the take is left with it. */
    private class NoTickets(private val inner: FakePost) : JamPostBackend by inner {
        override suspend fun ticket(songId: String, contentType: String, byteSize: Long): JamUploadTicket = throw IOException("offline")
    }

    @Test
    fun `discarding a first take removes the song that was made for it while it is still empty`() = runTest(dispatcher) {
        val draft = NewSongDraft("In Bloom", null, "open", emptyList(), "n-2")
        val vm = recordedReview(launch(songId = null, withBand = false, draft = draft), backend = NoTickets(post))
        vm.send()
        advanceUntilIdle()
        assertEquals("the song was made for the take", "song-new", vm.ui.value.take!!.createdSongId)
        assertEquals(StudioPhase.Review, vm.ui.value.phase)
        vm.discardTake()
        advanceUntilIdle()
        assertTrue(post.calls.contains("deleteIfEmpty:song-new"))
    }

    @Test
    fun `a second send of a first take does not make a second song`() = runTest(dispatcher) {
        val draft = NewSongDraft("In Bloom", null, "open", emptyList(), "n-3")
        val vm = recordedReview(launch(songId = null, withBand = false, draft = draft), backend = NoTickets(post))
        vm.send()
        advanceUntilIdle()
        vm.send()
        advanceUntilIdle()
        assertEquals(1, post.calls.count { it.startsWith("createSong") })
    }

    @Test
    fun `keeping a recording that is in progress saves it, it is never the way a take is lost`() = runTest(dispatcher) {
        calibrated()
        val vm = model().ready()
        vm.record()
        vm.keepAndClose()
        advanceUntilIdle()
        assertEquals(1, takes.all().size)
        assertTrue(duplexes.single().stopped)
        assertFalse(duplexes.single().cancelled)
    }

    @Test
    fun `a microphone that would not open can be tried again`() = runTest(dispatcher) {
        calibrated()
        micFailure = DuplexFailure.MicBusy
        val vm = model().ready()
        vm.record()
        assertEquals(StudioBlock.MicBusy, vm.ui.value.block)
        assertFalse(vm.ui.value.canRecord)
        micFailure = null
        vm.retryAfterBlock()
        assertNull(vm.ui.value.block)
        vm.record()
        assertEquals(StudioPhase.Countdown, vm.ui.value.phase)
    }

    @Test
    fun `a route that changes clears a device block, and a call's block stays until the call ends`() = runTest(dispatcher) {
        calibrated()
        micFailure = DuplexFailure.OutputFailed
        val vm = model().ready()
        vm.record()
        assertEquals(StudioBlock.OutputFailed, vm.ui.value.block)
        vm.refreshRoute()
        assertNull(vm.ui.value.block)
    }

    @Test
    fun `discarding a take that is playing gives the speaker back`() = runTest(dispatcher) {
        val vm = recordedReview()
        assertTrue(foci.last().held)
        vm.recordAgain()
        assertFalse(foci.last().held)
    }

    @Test
    fun `an unsent take belongs to the account that recorded it`() = runTest(dispatcher) {
        val first = recordedReview()
        val id = first.ui.value.take!!.id
        first.keepAndClose()
        assertNotNull(takes.load(id))
        assertNull("another account on the same phone is not offered it", takes.pending("chan", "song-1", "someone-else"))
        assertNull("and nor is a signed-out one, when the take has an owner", takes.pending("chan", "song-1", "x"))
    }

    @Test
    fun `the silence check does not hold up the review`() = runTest(dispatcher) {
        val vm = recordedReview()
        // The take of the simulated world is the band's echo: not silent. The flag is computed off the main thread and set after.
        assertFalse(vm.ui.value.silent)
    }
}
