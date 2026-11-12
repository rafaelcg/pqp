package gg.pqp.app.jam.record

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.SessionStore
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamLimits
import gg.pqp.app.jam.JamTrack
import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamFocusPolicy
import gg.pqp.app.jam.audio.JamMixer
import gg.pqp.app.jam.audio.JamPlayer
import gg.pqp.app.jam.audio.JamStemSpec
import gg.pqp.app.jam.audio.MIX_RATE
import gg.pqp.app.jam.audio.MappedPcm
import gg.pqp.app.jam.audio.PcmSource
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * THE STUDIO: recording a part over the band, hearing it with the band, nudging
 * it, and sending it. The state machine only; the arithmetic is in
 * `JamTakePlacement` and `JamLatency`, the hardware behind `Duplex`, and the
 * screen in `ui/JamStudioScreen`.
 *
 *   Setup -> (Measuring) -> Countdown -> Recording -> Review -> Posting -> Done
 *
 * Rules this holds, each of them a way a take could otherwise be lost or land
 * in the wrong place:
 *
 *  - NEVER WHILE IN A CALL. Recording opens the microphone and the speaker the
 *    call is using; the studio says so and does nothing, and a call that
 *    connects under a recording stops it and keeps what was played.
 *  - NEVER UNCALIBRATED. A take is placed with the correction measured for the
 *    audio route it is recorded on (`JamLatency`); no measurement for this
 *    route, no record button, only the measurement.
 *  - A FINISHED TAKE IS ON DISK before the review shows (`JamTakeStore`), and
 *    leaves it only when it is sent or the person throws it away. A take cut
 *    short (focus lost, headphones pulled, the app left, the microphone taken
 *    away) is kept when at least a second of it can be heard.
 *  - ONE PIPELINE for the calibration and the take: the same two streams, the
 *    same timestamp fit, so what the calibration absorbs is what a take needs.
 */

/** A track of the song the band plays, as the studio gets it from the song screen: its decoded audio is already there. */
class BackingStem(val track: JamTrack, val pcm: PcmSource, val frames: Long)

/** What opens the studio. */
data class JamStudioLaunch(
    val channelId: String,
    /** The song to add to; null for the first take of a song that does not exist yet ([draft]). */
    val songId: String?,
    val songTitle: String,
    val draft: NewSongDraft?,
    val backing: List<BackingStem>,
    /** The instruments the person may add a take for; a new song allows every one. */
    val addable: List<JamInstrument>,
    /** The instruments the song is asking for (a `wanted` song), marked in the picker. */
    val wanted: List<JamInstrument> = emptyList(),
    val initialInstrument: JamInstrument,
)

/**
 * One row of the band as the studio draws it: a track (the take being made is one too, built from its own numbers, so the
 * lane arithmetic is `JamTrack`'s and the same as the song screen's) and whose it is.
 */
data class StudioLane(
    val track: JamTrack,
    val name: String?,
    val mine: Boolean = false,
) {
    val id: String get() = track.id
    val instrument: JamInstrument get() = track.instrument
}

enum class StudioPhase { Setup, Measuring, Countdown, Recording, Review, Posting, Done }

/** Why the studio will not record, said instead of the record button. */
enum class StudioBlock { InCall, MicDenied, MicBusy, OutputFailed }

/** A line the screen says once. */
enum class StudioNotice {
    /** The take was cut short and kept. */
    CutKept,

    /** Cut short before anything worth keeping. */
    CutEmpty,
    NoFocus,
    Restored,
    MeasureFailed,
    MeasureSaved,
    NudgeSaved,
    PlaybackFailed,
    SaveFailed,
}

/** Why a take was cut short, for the line that says so. */
enum class CutReason { Focus, Unplugged, Background, Call, Mic, Route, Silenced, Died }

enum class MeasureMethod { Loopback, TapAlong }

data class JamStudioUi(
    val phase: StudioPhase = StudioPhase.Setup,
    val block: StudioBlock? = null,
    val micGranted: Boolean = false,
    val instrument: JamInstrument = JamInstrument.Guitar,
    val route: JamRoute? = null,
    /** The correction measured for this route, or null: then a measurement comes before a recording. */
    val calibration: LatencyResult? = null,
    val measuring: MeasureMethod? = null,
    val measureFailed: Boolean = false,
    val countInBars: Int = 1,
    val bpm: Int = DEFAULT_BPM,
    val beat: Int = 0,
    val beats: Int = 0,
    val elapsedMs: Long = 0,
    val lanes: List<StudioLane> = emptyList(),
    val originMs: Double = 0.0,
    val durationMs: Double = 0.0,
    val take: SavedTake? = null,
    val silent: Boolean = false,
    val playing: Boolean = false,
    val cut: CutReason? = null,
    val postStage: PostStage = PostStage.Encoding,
    val postFraction: Float = 0f,
    val postFailure: PostFailure? = null,
    /** The song was closed to new takes, or deleted, while the take waited: no retry can succeed. */
    val postFatal: Boolean = false,
    val sentSongId: String? = null,
    val notice: StudioNotice? = null,
    val callLive: Boolean = false,
) {
    /** A take can be recorded now: nothing in the way, and the route is measured. */
    val canRecord: Boolean
        get() = phase == StudioPhase.Setup && block == null && micGranted && !callLive && calibration != null

    /** The microphone can hear the band: the speaker is the output, so the take would carry it. */
    val bleeds: Boolean get() = route?.bleeds == true

    val bluetooth: Boolean get() = route?.outputKind == RouteKind.Bluetooth

    companion object {
        const val DEFAULT_BPM = 100
        const val MIN_BPM = 50
        const val MAX_BPM = 200
    }
}

enum class PostStage { Encoding, Creating, Uploading, Claiming }

class JamStudioViewModel(
    private val target: JamStudioLaunch,
    private val post: JamPostBackend,
    private val takes: JamTakeStore,
    private val latency: JamLatencyStore,
    private val routes: JamRouteProbe,
    private val newDuplex: (DuplexEvents) -> Duplex,
    private val focusFactory: (onChange: (JamFocusPolicy.Change) -> Unit, onNoisy: () -> Unit) -> StudioFocus,
    private val callActive: StateFlow<Boolean>,
    private val newPlayer: () -> JamPlayer = { JamPlayer() },
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val default: CoroutineDispatcher = Dispatchers.Default,
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val openPcm: (File) -> PcmSource = { MappedPcm(it) },
) : ViewModel() {
    private val _ui = MutableStateFlow(
        JamStudioUi(
            instrument = target.initialInstrument.takeIf { it in target.addable } ?: target.addable.firstOrNull() ?: target.initialInstrument,
            callLive = callActive.value,
            block = if (callActive.value) StudioBlock.InCall else null,
        ),
    )
    val ui: StateFlow<JamStudioUi> = _ui.asStateFlow()

    /** The instruments the picker offers as available, and the ones the song is asking for. */
    val addable: List<JamInstrument> get() = target.addable
    val wanted: List<JamInstrument> get() = target.wanted

    private val focus = focusFactory(::onFocusChange) { onBecomingNoisy() }
    private var duplex: Duplex? = null
    private var player: JamPlayer? = null
    private var takePcm: PcmSource? = null
    private var stopWatchingRoutes: (() -> Unit)? = null
    private var ticker: Job? = null
    private var measureJob: Job? = null
    private var postJob: Job? = null
    private var reviewPlayJob: Job? = null
    private var recording: Recording? = null
    private var resumeOnGain = false
    private var closed = false
    private var upload: Upload? = null

    /** The file of this take that is already (or about to be) in the bucket, and the ticket it went under. */
    private class Upload(val songId: String, val ticket: JamUploadTicket, var stored: Boolean = false) {
        /** A ticket is good for 15 minutes; one with under a minute left is not worth the PUT. A stored file needs no ticket. */
        fun usable(nowMs: Long): Boolean = stored || ticket.expiresAt.isBlank() || gg.pqp.app.jam.parseJamInstant(ticket.expiresAt) - nowMs > 60_000
    }

    /** The stems the band plays, placed on one timeline (the transport's zero is the earliest heard sample). */
    private class Band(val originMs: Double, val placed: List<Pair<gg.pqp.app.jam.audio.JamPlacement, PcmSource>>)

    private val band: Band = buildBand(extra = null)

    private class Recording(
        val id: String,
        val capture: File,
        val p0: Long,
        val beatFrames: Long,
        val preRoll: Long,
        val beats: Int,
        val routeKey: String,
        val fromMs: Double,
        val instrument: JamInstrument,
    )

    init {
        takes.sweepOrphans()
        _ui.update { it.copy(lanes = backingLanes(), originMs = band.originMs, durationMs = JamAlignment.durationMs(band.placed.map { p -> p.first })) }
        refreshRoute()
        stopWatchingRoutes = routes.watch { refreshRoute() }
        viewModelScope.launch {
            callActive.collect { active ->
                _ui.update { it.copy(callLive = active, block = if (active) StudioBlock.InCall else it.block.takeIf { b -> b != StudioBlock.InCall }) }
                if (active) onCall()
            }
        }
        restorePending()
    }

    // --- permission ---

    /** The screen asked (or was already granted): the microphone permission as it stands. */
    fun onMicPermission(granted: Boolean) {
        _ui.update {
            it.copy(
                micGranted = granted,
                block = if (granted && it.block == StudioBlock.MicDenied) null else if (!granted && it.block == null) StudioBlock.MicDenied else it.block,
            )
        }
    }

    // --- setup ---

    fun pickInstrument(instrument: JamInstrument) {
        if (instrument in target.addable) _ui.update { it.copy(instrument = instrument) }
    }

    fun setCountIn(bars: Int) = _ui.update { it.copy(countInBars = bars.coerceIn(0, 1)) }

    fun setBpm(bpm: Int) = _ui.update { it.copy(bpm = bpm.coerceIn(JamStudioUi.MIN_BPM, JamStudioUi.MAX_BPM)) }

    /** Re-reads which devices would be used, and which measurement (if any) belongs to them. */
    fun refreshRoute() {
        val route = routes.preview()
        _ui.update { it.copy(route = route, calibration = chooseFor(route.key)) }
    }

    private fun chooseFor(key: String): LatencyResult? {
        val stored = latency.get(key)
        return JamLatency.choose(stored, ClockMode.TIMESTAMPS) ?: JamLatency.choose(stored, ClockMode.APPROXIMATE)
    }

    // --- the band ---

    private fun buildBand(extra: JamStemSpec?, extraFrames: Long = 0): Band {
        val specs = target.backing.map { JamStemSpec(it.track.id, it.track.offsetMs, it.track.trimStartMs, it.track.trimEndMs, it.track.gain.toFloat()) } +
            listOfNotNull(extra)
        val origin = JamAlignment.originMs(specs)
        val placed = ArrayList<Pair<gg.pqp.app.jam.audio.JamPlacement, PcmSource>>()
        for (stem in target.backing) {
            val spec = specs.first { it.id == stem.track.id }
            JamAlignment.place(spec, stem.frames, origin)?.let { placed += it to stem.pcm }
        }
        if (extra != null) {
            val pcm = takePcm
            if (pcm != null) JamAlignment.place(extra, extraFrames, origin)?.let { placed += it to pcm }
        }
        return Band(origin, placed)
    }

    private fun backingLanes(): List<StudioLane> =
        target.backing.map { StudioLane(it.track, it.track.authorName) }
            .sortedBy { JamInstrument.entries.indexOf(it.instrument) }

    // --- measuring ---

    /** Plays a sound and listens for it (or for the person tapping along), and keeps what the route got wrong. */
    fun measure(method: MeasureMethod) {
        val u = _ui.value
        if (u.phase != StudioPhase.Setup || u.block != null || !u.micGranted || measureJob?.isActive == true) return
        measureJob = viewModelScope.launch {
            _ui.update { it.copy(phase = StudioPhase.Measuring, measuring = method, measureFailed = false, notice = null) }
            val result = try {
                runMeasurement(method)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
            val saved = result?.let { (key, r) -> if (r.usable) key to r else null }
            if (saved != null) latency.save(saved.first, saved.second)
            _ui.update {
                it.copy(
                    phase = StudioPhase.Setup,
                    measuring = null,
                    measureFailed = saved == null && !closed,
                    notice = if (saved != null) StudioNotice.MeasureSaved else null,
                )
            }
            refreshRoute()
        }
    }

    fun cancelMeasure() {
        // The job's own cancellation handler stops the streams and deletes the capture.
        measureJob?.cancel()
        measureJob = null
        _ui.update { if (it.phase == StudioPhase.Measuring) it.copy(phase = StudioPhase.Setup, measuring = null) else it }
    }

    /** The route key and the result, or null when nothing could be played or heard. */
    private suspend fun runMeasurement(method: MeasureMethod): Pair<String, LatencyResult>? {
        val rate = MIX_RATE
        val reference = JamSignals.sweep(rate, amplitude = 0.7f)
        val first: Int
        val period: Int
        val count: Int
        val at: List<Int>
        val signal: FloatArray
        if (method == MeasureMethod.Loopback) {
            first = (JamLatency.LOOPBACK_FIRST_MS / 1000 * rate).toInt()
            period = (JamLatency.PULSE_PERIOD_MS / 1000 * rate).toInt()
            count = 10
            at = List(count) { first + it * period }
            signal = JamSignals.pulseTrain(first + count * period, reference, at)
        } else {
            first = (0.5 * rate).toInt()
            period = (JamLatency.PULSE_PERIOD_MS / 1000 * rate).toInt()
            count = 12
            at = List(count) { first + it * period }
            val accent = JamSignals.click(rate, true)
            val plain = JamSignals.click(rate, false)
            val train = FloatArray(first + count * period)
            at.forEachIndexed { k, a ->
                val c = if (k % 4 == 0) accent else plain
                for (i in c.indices) if (a + i < train.size) train[a + i] += c[i]
            }
            signal = train
        }
        val capture = takes.pcm("measure")
        capture.delete()
        if (!focus.acquire()) {
            _ui.update { it.copy(notice = StudioNotice.NoFocus) }
            return null
        }
        val d = newDuplex(NoEvents)
        val failure = d.start(SignalSource(signal), capture, limitFrames = signal.size + (0.8 * rate).toLong(), outputEnds = signal.size.toLong())
        if (failure != null) {
            focus.release()
            _ui.update { it.copy(block = if (failure == DuplexFailure.OutputFailed) StudioBlock.OutputFailed else StudioBlock.MicBusy) }
            return null
        }
        duplex = d
        val listenUntil = signal.size + (0.7 * rate).toLong()
        val stamps = try {
            while (d.captured < listenUntil) delay(50)
            d.stop()
        } catch (e: CancellationException) {
            // Cancelled (the person, a call, the app left): nothing is left running or on disk.
            d.cancel(capture)
            throw e
        } finally {
            duplex = null
            focus.release()
        }
        val samples = withContext(io) { readFloats(capture) }
        capture.delete()
        val route = stamps.routeAtStart ?: _ui.value.route ?: return null
        return withContext(default) {
            val aP = JamTakePlacement.anchorNs(stamps.outputForPlacement, rate, at[count / 2].toLong()) ?: return@withContext null
            val aC = JamTakePlacement.anchorNs(stamps.captureForPlacement, rate, at[count / 2].toLong()) ?: return@withContext null
            // Where each sound would be in the capture if the platform's timestamps were exact.
            val expected = at.map { ((aP - aC) / 1e9 + it.toDouble() / rate) * rate }
            val result = if (method == MeasureMethod.Loopback) {
                JamLatency.analyseLoopback(samples, expected, reference, rate, stamps.mode, now())
            } else {
                JamLatency.analyseTapAlong(samples, expected, rate, stamps.mode, now())
            }
            route.key to result
        }
    }

    /** A number the person typed, or learned from a nudge: it beats every measurement for this route. */
    fun setManualCorrection(ms: Double) {
        val key = _ui.value.route?.key ?: return
        latency.save(key, JamLatency.manual(ms, ClockMode.TIMESTAMPS, now()))
        refreshRoute()
    }

    // --- recording ---

    fun record() {
        val u = _ui.value
        if (!u.canRecord || u.instrument !in target.addable) return
        if (callActive.value) return
        val route = u.route ?: return
        if (!focus.acquire()) {
            _ui.update { it.copy(notice = StudioNotice.NoFocus) }
            return
        }
        stopReview()
        val id = newId()
        val capture = takes.newCapture(id)
        val plan = JamTakeRenderer.plan(u.countInBars, BEATS_PER_BAR, u.bpm)
        val mixer = JamMixer().also { it.setStems(band.placed); it.snapLevels() }
        target.backing.forEach { mixer.setLevel(it.track.id, it.track.gain.toFloat()) }
        mixer.snapLevels()
        val renderer = JamTakeRenderer(mixer, plan.p0, plan.clicks)
        val events = object : DuplexEvents {
            override fun onTrouble(routeChanged: Boolean, silenced: Boolean) {
                if (silenced) cutShort(CutReason.Silenced) else if (routeChanged) cutShort(CutReason.Route)
            }

            override fun onDied() = cutShort(CutReason.Died)
        }
        val d = newDuplex(events)
        val failure = d.start(renderer, capture, limitFrames = (MAX_TAKE_MS * MIX_RATE / 1000L) + MIX_RATE)
        if (failure != null) {
            focus.release()
            _ui.update { it.copy(block = if (failure == DuplexFailure.OutputFailed) StudioBlock.OutputFailed else StudioBlock.MicBusy) }
            return
        }
        duplex = d
        recording = Recording(id, capture, plan.p0, Math.round(60.0 / u.bpm * MIX_RATE), JamTakeRenderer.PRE_ROLL_MS * MIX_RATE / 1000L, plan.beats, route.key, band.originMs, u.instrument)
        _ui.update { it.copy(phase = StudioPhase.Countdown, beat = 0, beats = plan.beats, elapsedMs = 0, notice = null, cut = null, take = null) }
        transportMs = -1.0
        peaksTick = 0
        startTicker()
    }

    private fun startTicker() {
        ticker?.cancel()
        ticker = viewModelScope.launch {
            while (isActive) {
                delay(TICK_MS)
                tick()
            }
        }
    }

    private fun tick() {
        val d = duplex ?: return
        val r = recording ?: return
        val frame = d.presentedOutputFrame() ?: return
        val sinceBand = frame - r.p0
        if (sinceBand < 0) {
            val beat = if (frame < r.preRoll) 0 else ((frame - r.preRoll) / r.beatFrames + 1).toInt().coerceAtMost(r.beats)
            transportMs = sinceBand * 1000.0 / MIX_RATE
            if (_ui.value.beat != beat) _ui.update { if (it.phase == StudioPhase.Countdown) it.copy(beat = beat) else it }
            return
        }
        transportMs = sinceBand * 1000.0 / MIX_RATE
        peaksTick += 1
        val elapsed = sinceBand * 1000L / MIX_RATE
        // The screen reads the clock to a tenth of a second: nothing recomposes between tenths.
        val shown = elapsed / 100 * 100
        if (_ui.value.phase != StudioPhase.Recording || _ui.value.elapsedMs != shown) {
            _ui.update { it.copy(phase = StudioPhase.Recording, elapsedMs = shown) }
        }
        if (elapsed >= MAX_TAKE_MS) stop()
    }

    /**
     * The band's transport position while recording, ms from its zero (negative during the count-in), and a counter that
     * moves as the live waveform grows. Compose state, so a draw lambda that reads them repaints without recomposing.
     */
    var transportMs by mutableDoubleStateOf(0.0)
        private set
    var peaksTick by mutableIntStateOf(0)
        private set

    /** The microphone's level right now, 0..1, read in a draw lambda. */
    fun level(): Float = duplex?.level ?: 0f

    fun livePeaks(): List<Float> = duplex?.livePeaks().orEmpty()

    fun stop() {
        val u = _ui.value
        if (u.phase != StudioPhase.Countdown && u.phase != StudioPhase.Recording) return
        finishRecording(cut = null)
    }

    /** The take ends by itself: keep what was played when there is enough of it, say so. */
    private fun cutShort(reason: CutReason) {
        val u = _ui.value
        if (u.phase != StudioPhase.Countdown && u.phase != StudioPhase.Recording) return
        finishRecording(cut = reason)
    }

    /** Stop and throw the take away without a word (the person said so). */
    fun cancelRecording() {
        val d = duplex ?: return
        val r = recording
        ticker?.cancel()
        d.cancel(r?.capture ?: takes.pcm("measure"))
        duplex = null
        recording = null
        focus.release()
        _ui.update { it.copy(phase = StudioPhase.Setup, elapsedMs = 0, beat = 0, cut = null) }
    }

    private fun finishRecording(cut: CutReason?) {
        val d = duplex ?: return
        val r = recording ?: return
        ticker?.cancel()
        val stamps = d.stop()
        duplex = null
        recording = null
        focus.release()
        viewModelScope.launch {
            val saved = withContext(default) { placeAndSave(r, stamps) }
            if (closed) return@launch
            if (saved == null) {
                _ui.update { it.copy(phase = StudioPhase.Setup, elapsedMs = 0, beat = 0, notice = if (cut != null) StudioNotice.CutEmpty else StudioNotice.SaveFailed, cut = cut) }
                return@launch
            }
            val heardMs = saved.durationMs - saved.trimStartMs
            if (cut != null && heardMs < MIN_KEPT_MS) {
                takes.delete(saved.id)
                _ui.update { it.copy(phase = StudioPhase.Setup, elapsedMs = 0, beat = 0, notice = StudioNotice.CutEmpty, cut = cut) }
                return@launch
            }
            enterReview(saved, cut)
        }
    }

    /** From the two streams' stamps to a placed, saved take. Null when the capture is unusable. */
    private fun placeAndSave(r: Recording, stamps: DuplexResult): SavedTake? {
        if (stamps.capturedFrames < MIN_CAPTURE_FRAMES) return null
        val aP = JamTakePlacement.anchorNs(stamps.outputForPlacement, MIX_RATE, r.p0) ?: return null
        val aC = JamTakePlacement.anchorNs(stamps.captureForPlacement, MIX_RATE, 0) ?: return null
        // The route as the streams actually ran on it: the preview the person calibrated under may have been wrong.
        val actualKey = stamps.routeAtStart?.key ?: r.routeKey
        val stored = latency.get(actualKey)
        val chosen = JamLatency.choose(stored, stamps.mode)
        val correction = chosen?.correctionMs ?: 0.0
        val raw = JamTakePlacement.rawOffsetMs(r.fromMs, r.p0, aP, aC, correction, MIX_RATE)
        val placed = JamTakePlacement.finish(stamps.capturedFrames, r.fromMs, raw, MIX_RATE)
        val pcm = openPcm(r.capture)
        val peaks = try {
            JamTakeAudio.peaks(pcm, placed.dropFrames.toLong(), placed.frames)
        } finally {
            pcm.close()
        }
        val take = SavedTake(
            id = r.id,
            channelId = target.channelId,
            songId = target.songId,
            draft = target.draft,
            instrument = r.instrument.wire,
            offsetMs = placed.offsetMs,
            trimStartMs = placed.trimStartMs,
            durationMs = placed.durationMs,
            dropFrames = placed.dropFrames,
            frames = placed.frames,
            peaks = peaks,
            correctionMs = correction,
            routeKey = actualKey,
            routeChanged = stamps.routeChanged,
            uncalibrated = chosen == null,
            savedAt = now(),
        )
        takes.save(take)
        return take
    }

    // --- review ---

    private fun restorePending() {
        val saved = takes.pending(target.channelId, target.songId) ?: return
        enterReview(saved, cut = null, restored = true)
    }

    private fun enterReview(saved: SavedTake, cut: CutReason?, restored: Boolean = false) {
        takePcm?.close()
        val pcm = OffsetPcm(openPcm(takes.pcm(saved.id)), saved.dropFrames.toLong())
        takePcm = pcm
        val silent = JamTakeAudio.isSilent(pcm, 0, saved.frames, JamAlignment.frames(saved.trimStartMs))
        _ui.update {
            it.copy(
                phase = StudioPhase.Review,
                take = saved,
                silent = silent,
                cut = cut,
                instrument = JamInstrument.fromWire(saved.instrument),
                notice = if (restored) StudioNotice.Restored else null,
                postFailure = null,
                postFatal = false,
            )
        }
        reloadReview()
        // Hear it with the band straight away: stopping was the gesture.
        reviewPlayJob?.cancel()
        if (!restored) reviewPlayJob = viewModelScope.launch {
            delay(REVIEW_PLAY_DELAY_MS)
            playReview(fromStart = true)
        }
    }

    private fun takeSpec(take: SavedTake) =
        JamStemSpec(TAKE_ID, take.placedOffsetMs, take.trimStartMs, 0.0, 1f)

    /** Puts the band and the take on one timeline and hands it to the player, keeping the playhead. */
    private fun reloadReview() {
        val take = _ui.value.take ?: return
        val laid = buildBand(takeSpec(take), take.frames)
        val p = player ?: newPlayer().also { fresh ->
            player = fresh
            viewModelScope.launch { fresh.ended.collect { _ui.update { it.copy(playing = false) } } }
            viewModelScope.launch { fresh.failures.collect { _ui.update { it.copy(playing = false, notice = StudioNotice.PlaybackFailed) } } }
        }
        p.load(laid.placed)
        target.backing.forEach { p.setLevel(it.track.id, it.track.gain.toFloat()) }
        val mine = StudioLane(
            JamTrack(
                id = TAKE_ID, songId = take.songId.orEmpty(), instrument = JamInstrument.fromWire(take.instrument),
                offsetMs = take.placedOffsetMs, trimStartMs = take.trimStartMs, trimEndMs = 0.0, durationMs = take.durationMs,
                peaks = take.peaks, inMix = true,
            ),
            name = null,
            mine = true,
        )
        _ui.update { it.copy(lanes = backingLanes() + mine, originMs = laid.originMs, durationMs = p.durationMs.value) }
    }

    fun togglePlay() {
        if (_ui.value.playing) pauseReview() else playReview(fromStart = false)
    }

    private fun playReview(fromStart: Boolean) {
        if (_ui.value.phase != StudioPhase.Review) return
        val p = player ?: return
        if (callActive.value) return
        if (!focus.acquire()) {
            _ui.update { it.copy(notice = StudioNotice.NoFocus) }
            return
        }
        resumeOnGain = false
        if (fromStart) p.seekTo(0.0)
        p.play()
        _ui.update { it.copy(playing = true) }
    }

    fun pauseReview() {
        player?.pause()
        _ui.update { it.copy(playing = false) }
        if (!resumeOnGain) focus.release()
    }

    private fun stopReview() {
        reviewPlayJob?.cancel()
        player?.pause()
        _ui.update { if (it.playing) it.copy(playing = false) else it }
    }

    fun seekReview(ms: Double) {
        player?.seekTo(ms.coerceIn(0.0, _ui.value.durationMs))
    }

    /** The heard position, ms from the transport's zero. Read in a draw lambda. */
    fun reviewPositionMs(): Double = player?.positionMs() ?: 0.0

    /** Nudge the whole take earlier (negative) or later: the player hears it at once, nothing is re-rendered. */
    fun nudge(deltaMs: Int) {
        val take = _ui.value.take ?: return
        if (_ui.value.phase != StudioPhase.Review) return
        val next = take.copy(nudgeMs = JamTakeEdit.clampNudge(take.nudgeMs + deltaMs))
        if (next.nudgeMs == take.nudgeMs) return
        takes.save(next)
        _ui.update { it.copy(take = next) }
        reloadReview()
    }

    fun resetNudge() {
        val take = _ui.value.take ?: return
        if (take.nudgeMs != 0) nudge(-take.nudgeMs)
    }

    /** "Every take of mine on this route lands early or late by this much": the nudge becomes the route's correction. */
    fun keepNudgeForRoute() {
        val take = _ui.value.take ?: return
        if (take.nudgeMs == 0) return
        val key = take.routeKey.ifEmpty { return }
        latency.save(key, JamLatency.manual(take.correctionMs - take.nudgeMs, ClockMode.TIMESTAMPS, now()))
        _ui.update { it.copy(notice = StudioNotice.NudgeSaved) }
        refreshRoute()
    }

    /** Throw the take away and go back to the start. */
    fun recordAgain() {
        discardTake()
        _ui.update { it.copy(phase = StudioPhase.Setup, elapsedMs = 0, beat = 0, cut = null, notice = null, postFailure = null) }
    }

    /** The person said so: the take and its files go, and a song made only for it is not left empty. */
    fun discardTake() {
        postJob?.cancel()
        upload = null
        stopReview()
        val take = _ui.value.take
        takePcm?.close()
        takePcm = null
        if (take != null) {
            takes.delete(take.id)
            val created = take.createdSongId
            if (created != null && take.songId == null) {
                viewModelScope.launch { runCatching { post.deleteSongIfEmpty(created) } }
            }
        }
        player?.pause()
        _ui.update {
            it.copy(
                take = null,
                silent = false,
                lanes = backingLanes(),
                originMs = band.originMs,
                durationMs = JamAlignment.durationMs(band.placed.map { p -> p.first }),
                phase = if (it.phase == StudioPhase.Done) it.phase else StudioPhase.Setup,
            )
        }
    }

    // --- sending ---

    fun send() {
        val u = _ui.value
        val take = u.take ?: return
        if (u.phase != StudioPhase.Review || postJob?.isActive == true) return
        stopReview()
        focus.release()
        postJob = viewModelScope.launch {
            _ui.update { it.copy(phase = StudioPhase.Posting, postStage = PostStage.Encoding, postFraction = 0f, postFailure = null) }
            try {
                val songId = ensureSong(take)
                val sent = takes.load(take.id) ?: take
                val flac = withContext(io) { encode(sent) }
                _ui.update { it.copy(postStage = PostStage.Uploading, postFraction = 0f) }
                // A retry reuses the upload it already made: the claim is idempotent on the upload id, so a retry after
                // a connection that died with the answer in flight returns the same track instead of making a second.
                val up = upload?.takeIf { it.songId == songId && it.usable(now()) }
                    ?: Upload(songId, post.ticket(songId, "audio/flac", flac.length())).also { upload = it }
                if (!up.stored) {
                    post.put(up.ticket, flac, "audio/flac") { sentBytes ->
                        val f = sentBytes.toFloat() / max(1L, flac.length())
                        _ui.update { if (it.phase == StudioPhase.Posting) it.copy(postFraction = f.coerceIn(0f, 1f)) else it }
                    }
                    up.stored = true
                }
                val ticket = up.ticket
                _ui.update { it.copy(postStage = PostStage.Claiming) }
                val answer = post.addTrack(
                    songId,
                    AddJamTrackRequest(
                        instrument = sent.instrument,
                        label = null,
                        audioUploadId = ticket.uploadId,
                        durationMs = sent.durationMs.roundToInt().coerceIn(JamTakeStudioLimits.MIN_TRACK_MS, JamLimits.TRACK_MAX_DURATION_MS),
                        offsetMs = sent.placedOffsetMs,
                        trimStartMs = sent.trimStartMs.roundToInt().toDouble(),
                        trimEndMs = 0.0,
                        gain = 1.0,
                        peaks = sent.peaks,
                    ),
                )
                // Sent: nothing is left to lose, so the files go.
                takePcm?.close()
                takePcm = null
                takes.delete(take.id)
                _ui.update { it.copy(phase = StudioPhase.Done, sentSongId = answer.song.id, postFraction = 1f) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val failure = postFailureOf(e)
                _ui.update {
                    it.copy(
                        phase = StudioPhase.Review,
                        postFailure = failure,
                        postFatal = failure == PostFailure.Gone || failure == PostFailure.Closed || failure == PostFailure.Off ||
                            failure == PostFailure.InstrumentNotWanted || failure == PostFailure.SongFull || failure == PostFailure.AuthorLimit,
                    )
                }
            }
        }
    }

    /** The song to put the take in: the one it was recorded over, or the one made for it (once; a retry reuses it). */
    private suspend fun ensureSong(take: SavedTake): String {
        take.songId?.let { return it }
        take.createdSongId?.let { return it }
        val draft = take.draft ?: error("a take with no song and no draft")
        _ui.update { it.copy(postStage = PostStage.Creating) }
        val song = post.createSong(
            take.channelId,
            CreateJamSongRequest(
                title = draft.title,
                artist = draft.artist,
                joinMode = draft.joinMode,
                wantedInstruments = draft.wantedInstruments.takeIf { draft.joinMode == "wanted" } ?: emptyList(),
                nonce = draft.nonce,
            ),
        )
        val withSong = take.copy(createdSongId = song.id)
        takes.save(withSong)
        _ui.update { it.copy(take = withSong) }
        return song.id
    }

    /** The encoded copy is kept, so a retry sends the same bytes (and the same upload) without encoding again. */
    private fun encode(take: SavedTake): File {
        val out = takes.flac(take.id)
        if (out.isFile && out.length() > 0) return out
        val tmp = File(out.path + ".part")
        val pcm = OffsetPcm(openPcm(takes.pcm(take.id)), take.dropFrames.toLong())
        try {
            tmp.outputStream().buffered().use { JamFlac.encode(pcm, 0, take.frames, MIX_RATE, it) }
        } finally {
            pcm.close()
        }
        check(tmp.renameTo(out)) { "could not store the encoded take" }
        return out
    }

    fun dismissNotice() = _ui.update { it.copy(notice = null) }

    // --- the world interrupting ---

    private fun onFocusChange(change: JamFocusPolicy.Change) {
        val phase = _ui.value.phase
        when (phase) {
            StudioPhase.Countdown, StudioPhase.Recording -> if (change != JamFocusPolicy.Change.Gain && change != JamFocusPolicy.Change.LossTransientCanDuck) cutShort(CutReason.Focus)
            StudioPhase.Review -> {
                val decision = JamFocusPolicy.onChange(change, _ui.value.playing, resumeOnGain, callActive.value)
                resumeOnGain = decision.resumeOnGain
                when (decision.action) {
                    JamFocusPolicy.Action.Pause, JamFocusPolicy.Action.PauseUntilGain -> {
                        player?.pause()
                        _ui.update { it.copy(playing = false) }
                    }
                    JamFocusPolicy.Action.Resume -> playReview(fromStart = false)
                    JamFocusPolicy.Action.Duck -> player?.setMasterLevel(JamFocusPolicy.DUCKED_LEVEL)
                    JamFocusPolicy.Action.Unduck -> player?.setMasterLevel(1f)
                    JamFocusPolicy.Action.None -> Unit
                }
            }
            else -> Unit
        }
    }

    private fun onBecomingNoisy() {
        when (_ui.value.phase) {
            StudioPhase.Countdown, StudioPhase.Recording -> cutShort(CutReason.Unplugged)
            StudioPhase.Review -> if (_ui.value.playing) pauseReview()
            StudioPhase.Measuring -> cancelMeasure()
            else -> Unit
        }
    }

    private fun onCall() {
        when (_ui.value.phase) {
            StudioPhase.Countdown, StudioPhase.Recording -> cutShort(CutReason.Call)
            StudioPhase.Measuring -> cancelMeasure()
            StudioPhase.Review -> if (_ui.value.playing) pauseReview()
            else -> Unit
        }
    }

    /** The app left the screen: a microphone cannot be held in the background, so a take in progress ends here and is kept. */
    fun onBackgrounded() {
        when (_ui.value.phase) {
            StudioPhase.Countdown, StudioPhase.Recording -> cutShort(CutReason.Background)
            StudioPhase.Measuring -> cancelMeasure()
            StudioPhase.Review -> if (_ui.value.playing) pauseReview()
            else -> Unit
        }
    }

    // --- leaving ---

    /** What leaving would lose, for the screen to ask about. */
    fun leaveRisk(): LeaveRisk = when (_ui.value.phase) {
        StudioPhase.Countdown, StudioPhase.Recording -> LeaveRisk.Recording
        StudioPhase.Review, StudioPhase.Posting -> LeaveRisk.UnsentTake
        else -> LeaveRisk.None
    }

    /** Leave with the take kept for later (it is on disk already). */
    fun keepAndClose() {
        if (_ui.value.phase == StudioPhase.Countdown || _ui.value.phase == StudioPhase.Recording) cancelRecording()
        releaseAll()
    }

    /** Leave and let nothing behind: the take, and a song made only for it. */
    fun discardAndClose() {
        if (_ui.value.phase == StudioPhase.Countdown || _ui.value.phase == StudioPhase.Recording) {
            cancelRecording()
        } else {
            discardTake()
        }
        releaseAll()
    }

    private fun releaseAll() {
        if (closed) return
        closed = true
        ticker?.cancel()
        measureJob?.cancel()
        reviewPlayJob?.cancel()
        stopWatchingRoutes?.invoke()
        stopWatchingRoutes = null
        // A recording the studio disappears under (the screen was torn down) ends here and is kept if it is long enough.
        val d = duplex
        val r = recording
        if (d != null && r != null) {
            val stamps = d.stop()
            duplex = null
            recording = null
            val saved = runCatching { placeAndSave(r, stamps) }.getOrNull()
            if (saved != null && saved.durationMs - saved.trimStartMs < MIN_KEPT_MS) takes.delete(saved.id)
        }
        focus.release()
        player?.release()
        player = null
        takePcm?.close()
        takePcm = null
    }

    override fun onCleared() = releaseAll()

    enum class LeaveRisk { None, Recording, UnsentTake }

    private object NoEvents : DuplexEvents {
        override fun onTrouble(routeChanged: Boolean, silenced: Boolean) = Unit
        override fun onDied() = Unit
    }

    private fun readFloats(file: File): FloatArray {
        val bytes = file.readBytes()
        val out = FloatArray(bytes.size / 2)
        for (i in out.indices) {
            val v = (bytes[2 * i].toInt() and 0xFF) or (bytes[2 * i + 1].toInt() shl 8)
            out[i] = v.toShort() / 32768f
        }
        return out
    }

    companion object {
        const val BEATS_PER_BAR = 4
        const val TAKE_ID = "take"
        const val TICK_MS = 33L

        /** A take stops itself a few seconds before the server's ten minute ceiling. */
        const val MAX_TAKE_MS = JamLimits.TRACK_MAX_DURATION_MS - 5_000L

        /** A take cut short is kept when at least this much of it can be heard. */
        const val MIN_KEPT_MS = 1_000.0
        const val MIN_CAPTURE_FRAMES = MIX_RATE / 4L
        const val REVIEW_PLAY_DELAY_MS = 380L

        fun factory(
            session: SessionStore,
            context: Context,
            target: JamStudioLaunch,
            callActive: StateFlow<Boolean>,
        ) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                val app = context.applicationContext
                return JamStudioViewModel(
                    target = target,
                    post = SessionJamPostBackend(session),
                    takes = JamTakeStore(File(app.filesDir, "jam-takes")),
                    latency = JamLatencyStore(PrefsKeyValue(app)),
                    routes = AudioRouteProbe(app),
                    newDuplex = { events -> JamDuplex(app, events) },
                    focusFactory = { change, noisy -> AndroidStudioFocus(app, change, noisy) },
                    callActive = callActive,
                ) as T
            }
        }
    }
}

/** The limits a take is held to, from `jam.ts` (`JamRecordContractTest` pins each). */
object JamTakeStudioLimits {
    /** `JAM_TRACK_MIN_DURATION_MS`: shorter is a tap on the record button. */
    const val MIN_TRACK_MS = 300

    /** `JAM_TRACK_MAX_DURATION_MS`: ten minutes. */
    const val MAX_TRACK_MS = JamLimits.TRACK_MAX_DURATION_MS

    /** `JAM_OFFSET_MAX_MS`: `|offsetMs|` may not exceed this. */
    const val OFFSET_MAX_MS = 10 * 60 * 1000
}
