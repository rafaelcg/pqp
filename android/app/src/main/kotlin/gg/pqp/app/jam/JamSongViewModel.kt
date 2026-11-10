package gg.pqp.app.jam

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionStore
import gg.pqp.app.jam.audio.JamAlignment
import gg.pqp.app.jam.audio.JamAudioFocus
import gg.pqp.app.jam.audio.JamFocusPolicy
import gg.pqp.app.jam.audio.JamPlayer
import gg.pqp.app.jam.audio.JamStemLoader
import gg.pqp.app.jam.audio.JamStemSpec
import gg.pqp.app.jam.audio.JamVideoStage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/** How a stem is doing on its way to the speaker. */
enum class JamStemStatus { Loading, Ready, Unplayable }

/** A one-line thing the screen says and then forgets. */
enum class JamNotice { CallLive, NoFocus, VoteFailed, MixFailed, DeleteFailed }

data class JamSongUi(
    val phase: Phase = Phase.Loading,
    val state: JamSongState? = null,
    /** Local to this phone: what the listener silenced or isolated. Never sent anywhere. */
    val muted: Set<String> = emptySet(),
    val soloed: Set<String> = emptySet(),
    val volumes: Map<String, Float> = emptyMap(),
    /** The out-of-mix take the listener is hearing in place of the mix's, per instrument. */
    val auditioning: Map<JamInstrument, String> = emptyMap(),
    val stems: Map<String, JamStemStatus> = emptyMap(),
    /** A write on this track is in flight. */
    val busy: Set<String> = emptySet(),
    val notice: JamNotice? = null,
    /** The tracks whose video is on the stage, in order. */
    val videoTracks: List<JamTrack> = emptyList(),
    /** Where the transport's zero sits on the song timeline, and how long the mix is, from what is loaded. */
    val originMs: Double = 0.0,
    val durationMs: Double = 0.0,
    val playing: Boolean = false,
    /** A call is live on this device: a song does not start under it. */
    val callLive: Boolean = false,
) {
    enum class Phase { Loading, Ready, Failed, Gone }

    private val tracks get() = state?.tracks.orEmpty()
    val stack: List<JamTrack> get() = JamMixRules.stack(tracks, auditioning)
    val otherTakes: List<JamTrack> get() = JamMixRules.otherTakes(tracks, auditioning)

    /** Every stem that is wanted has an answer, and at least one can play. */
    val ready: Boolean
        get() {
            val active = stack
            return active.isNotEmpty() &&
                active.none { stems[it.id] == null || stems[it.id] == JamStemStatus.Loading } &&
                active.any { stems[it.id] == JamStemStatus.Ready }
        }

    val preparing: Boolean
        get() = phase == Phase.Ready && stack.any { stems[it.id] == null || stems[it.id] == JamStemStatus.Loading }

    fun audible(trackId: String) = JamMixRules.isAudible(trackId, soloed, muted)
    fun volume(trackId: String) = volumes[trackId] ?: 1f
}

/**
 * One song: its tracks, the engine that plays them, and the seven frames
 * applied to both.
 *
 * ENGINE: a single `AudioTrack` fed by `JamMixer` (see its header for why not
 * several players). This object decides which tracks are in the mix (the
 * in-mix ones, or the competing take the listener is auditioning), downloads
 * and decodes them (`JamStemLoader`), places them (`JamAlignment`) and hands
 * the engine the result. A stem that cannot be decoded is marked so and left
 * out; the rest play.
 *
 * Position is read, not collected: [onFrame] is called from the screen's frame
 * clock while it is on screen, so a playhead moving 60 times a second never
 * recomposes anything.
 */
class JamSongViewModel(
    private val backend: JamBackend,
    context: Context,
    http: OkHttpClient,
    private val songId: String,
    private val channelId: String,
    private val callActive: StateFlow<Boolean>,
    private val player: JamPlayer = JamPlayer(),
) : ViewModel() {
    private val appContext = context.applicationContext
    private val loader = JamStemLoader(appContext, http)
    private val video = JamVideoStage(appContext)

    private val _ui = MutableStateFlow(JamSongUi(callLive = callActive.value))
    val ui: StateFlow<JamSongUi> = _ui.asStateFlow()

    /** The heard position in ms from the transport's zero. Read in a draw lambda, never in composition. */
    var positionMs by mutableDoubleStateOf(0.0)
        private set

    /** The player of the video on stage `trackId`, for the surface that draws it. */
    fun videoPlayer(trackId: String) = video.player(trackId)

    private val results = HashMap<String, JamStemLoader.Result>()
    private var resumeOnGain = false
    private var ducked = false
    private var lastVideoSyncNanos = 0L

    private val focus = JamAudioFocus(
        appContext,
        onChange = ::onFocusChange,
        onBecomingNoisy = { apply(JamFocusPolicy.onBecomingNoisy(_ui.value.playing)) },
    )

    init {
        // The wall's view model owns the channel's socket slot for as long as this screen is up; a song only listens.
        viewModelScope.launch { backend.frames.collect(::onFrame) }
        viewModelScope.launch {
            callActive.collect { active ->
                _ui.update { it.copy(callLive = active) }
                if (active) apply(JamFocusPolicy.onCallActive(_ui.value.playing))
            }
        }
        viewModelScope.launch {
            player.ended.collect {
                focus.release()
                positionMs = 0.0
                _ui.update { it.copy(playing = false) }
                video.park(_ui.value.originMs)
            }
        }
        load()
    }

    // --- reading ---

    fun load() {
        viewModelScope.launch {
            try {
                val detail = backend.song(songId)
                results.clear()
                _ui.update {
                    it.copy(
                        phase = JamSongUi.Phase.Ready,
                        state = JamSongState(detail.song, detail.tracks, detail.viewer),
                        stems = emptyMap(),
                    )
                }
                syncStems()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                _ui.update { it.copy(phase = if (e.status == 404) JamSongUi.Phase.Gone else JamSongUi.Phase.Failed) }
            } catch (_: Exception) {
                _ui.update { if (it.state == null) it.copy(phase = JamSongUi.Phase.Failed) else it }
            }
        }
    }

    // --- the seven frames ---

    private fun onFrame(frame: JamFrame) {
        if (frame.channelId != channelId) return
        val current = _ui.value.state ?: return
        val applied = current.apply(frame, auditioned = _ui.value.auditioning.values.toSet())
        if (applied.state == current) return
        _ui.update {
            it.copy(
                state = applied.state,
                phase = if (applied.state.wasDeleted) JamSongUi.Phase.Gone else it.phase,
            )
        }
        if (applied.state.wasDeleted) {
            stopEverything()
            return
        }
        when (applied.effect) {
            JamEffect.ReloadStems -> {
                // A moved or removed stem invalidates what was decoded for it only if its file changed (it did not): keep the cache.
                dropAuditionsOfDeleted(applied.state)
                syncStems()
            }
            JamEffect.Levels -> applyLevels()
            JamEffect.None -> Unit
        }
    }

    private fun dropAuditionsOfDeleted(state: JamSongState) {
        val ids = state.tracks.mapTo(HashSet()) { it.id }
        _ui.update { it.copy(auditioning = it.auditioning.filterValues { id -> id in ids }) }
    }

    // --- stems ---

    private fun syncStems() {
        val ui = _ui.value
        val state = ui.state ?: return
        val active = JamMixRules.activeTracks(state.tracks, ui.auditioning)
        val wanted = active.mapTo(HashSet()) { it.id }
        results.keys.retainAll(wanted)
        _ui.update { it.copy(stems = it.stems.filterKeys { id -> id in wanted }) }
        for (track in active) {
            if (track.id in results || _ui.value.stems[track.id] == JamStemStatus.Loading) continue
            _ui.update { it.copy(stems = it.stems + (track.id to JamStemStatus.Loading)) }
            viewModelScope.launch {
                val result = loader.load(track)
                results[track.id] = result
                _ui.update {
                    it.copy(
                        stems = it.stems + (
                            track.id to if (result is JamStemLoader.Result.Ready) JamStemStatus.Ready else JamStemStatus.Unplayable
                            ),
                    )
                }
                rebuild()
            }
        }
        video.load(active.filter { it.hasVideo })
        _ui.update { it.copy(videoTracks = video.tracks) }
        rebuild()
    }

    /** Hands the engine the stems that are ready, once none of the wanted ones is still on its way. */
    private fun rebuild() {
        val ui = _ui.value
        val state = ui.state ?: return
        val active = JamMixRules.activeTracks(state.tracks, ui.auditioning)
        if (active.any { results[it.id] == null }) return
        val readyTracks = active.filter { results[it.id] is JamStemLoader.Result.Ready }
        val specs = readyTracks.map { JamStemSpec(it.id, it.offsetMs, it.trimStartMs, it.trimEndMs, it.gain.toFloat()) }
        val origin = JamAlignment.originMs(specs)
        val placed = readyTracks.mapNotNull { track ->
            val result = results[track.id] as JamStemLoader.Result.Ready
            val spec = specs.first { it.id == track.id }
            JamAlignment.place(spec, result.frames, origin)?.let { it to result.pcm }
        }
        player.load(placed)
        _ui.update { it.copy(originMs = origin, durationMs = player.durationMs.value) }
        applyLevels()
        video.park(origin + positionMs)
    }

    private fun applyLevels() {
        val ui = _ui.value
        val state = ui.state ?: return
        for (track in JamMixRules.activeTracks(state.tracks, ui.auditioning)) {
            val level = if (ui.audible(track.id)) (track.gain * ui.volume(track.id)).toFloat() else 0f
            player.setLevel(track.id, level)
        }
    }

    // --- transport ---

    fun togglePlay() {
        if (_ui.value.playing) pause() else play()
    }

    fun play() {
        val ui = _ui.value
        if (!ui.ready) return
        if (!JamFocusPolicy.mayStart(callActive.value)) {
            notice(JamNotice.CallLive)
            return
        }
        if (!focus.acquire()) {
            notice(JamNotice.NoFocus)
            return
        }
        resumeOnGain = false
        player.play()
        _ui.update { it.copy(playing = true) }
        lastVideoSyncNanos = 0
    }

    fun pause() {
        player.pause()
        _ui.update { it.copy(playing = false) }
        video.pause()
        video.park(_ui.value.originMs + player.positionMs())
        positionMs = player.positionMs()
        if (!resumeOnGain) focus.release()
    }

    fun seekTo(ms: Double) {
        player.seekTo(ms)
        positionMs = ms
        if (_ui.value.playing) video.sync(_ui.value.originMs + ms) else video.park(_ui.value.originMs + ms)
    }

    /** From the screen's frame clock while it is showing: the heard position, and the video kept on it. */
    fun onClock(nowNanos: Long) {
        if (!_ui.value.playing) return
        val pos = player.positionMs()
        positionMs = pos
        if (nowNanos - lastVideoSyncNanos >= VIDEO_SYNC_NANOS) {
            lastVideoSyncNanos = nowNanos
            video.sync(_ui.value.originMs + pos)
        }
    }

    /** The app left the screen: a song with no controls in reach is paused, not left playing to nobody. */
    fun onBackgrounded() {
        if (_ui.value.playing) pause()
    }

    private fun apply(action: JamFocusPolicy.Action) {
        when (action) {
            JamFocusPolicy.Action.None -> Unit
            JamFocusPolicy.Action.Pause -> {
                resumeOnGain = false
                pause()
            }
            JamFocusPolicy.Action.PauseUntilGain -> {
                resumeOnGain = true
                pause()
            }
            JamFocusPolicy.Action.Resume -> {
                resumeOnGain = false
                play()
            }
            JamFocusPolicy.Action.Duck -> {
                ducked = true
                player.setMasterLevel(JamFocusPolicy.DUCKED_LEVEL)
            }
            JamFocusPolicy.Action.Unduck -> {
                ducked = false
                player.setMasterLevel(1f)
            }
        }
    }

    private fun onFocusChange(change: JamFocusPolicy.Change) {
        val decision = JamFocusPolicy.onChange(change, _ui.value.playing, resumeOnGain, callActive.value)
        resumeOnGain = decision.resumeOnGain
        apply(decision.action)
        // A permanent loss gives focus back; a transient one keeps the request to be told when it returns.
        if (decision.action == JamFocusPolicy.Action.Pause) focus.release()
    }

    // --- the mix, locally ---

    fun toggleMute(trackId: String) {
        _ui.update { it.copy(muted = if (trackId in it.muted) it.muted - trackId else it.muted + trackId) }
        applyLevels()
    }

    fun toggleSolo(trackId: String) {
        _ui.update { it.copy(soloed = if (trackId in it.soloed) it.soloed - trackId else it.soloed + trackId) }
        applyLevels()
    }

    fun setVolume(trackId: String, volume: Float) {
        _ui.update { it.copy(volumes = it.volumes + (trackId to volume.coerceIn(0f, 1f))) }
        applyLevels()
    }

    /** Hear this competing take in place of the mix's take(s) of its instrument; [stopAudition] puts the mix back. */
    fun audition(track: JamTrack) {
        _ui.update { it.copy(auditioning = it.auditioning + (track.instrument to track.id)) }
        syncStems()
    }

    fun stopAudition(instrument: JamInstrument) {
        _ui.update { it.copy(auditioning = it.auditioning - instrument) }
        syncStems()
    }

    // --- writes ---

    /** Vote or take the vote back. Optimistic, settled by the answer, undone by a failure. */
    fun toggleVote(track: JamTrack) {
        val state = _ui.value.state ?: return
        if (track.id in _ui.value.busy) return
        val voted = track.id in state.viewer.votedTrackIds
        val optimistic = state.apply(
            JamVoteResponse(track.id, state.song.id, (track.voteCount + if (voted) -1 else 1).coerceAtLeast(0), !voted),
        )
        _ui.update { it.copy(state = optimistic, busy = it.busy + track.id) }
        viewModelScope.launch {
            try {
                val answer = backend.vote(track.id, voted = !voted)
                _ui.update { ui -> ui.copy(state = ui.state?.apply(answer)) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _ui.update { ui ->
                    ui.copy(
                        state = ui.state?.apply(JamVoteResponse(track.id, state.song.id, track.voteCount, voted)),
                        notice = JamNotice.VoteFailed,
                    )
                }
            } finally {
                _ui.update { it.copy(busy = it.busy - track.id) }
            }
        }
    }

    fun setInMix(track: JamTrack, inMix: Boolean) {
        val state = _ui.value.state ?: return
        if (!JamPermissions.canSetMix(state.viewer) || track.id in _ui.value.busy) return
        _ui.update { it.copy(busy = it.busy + track.id) }
        viewModelScope.launch {
            try {
                val answer = backend.setInMix(track.id, inMix)
                // The frame will say the same; applying the answer now makes the switch feel instant and is idempotent.
                onFrame(JamFrame.TrackUpdated(channelId, answer.song, answer.track))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                notice(JamNotice.MixFailed)
            } finally {
                _ui.update { it.copy(busy = it.busy - track.id) }
            }
        }
    }

    fun deleteTrack(track: JamTrack) {
        val state = _ui.value.state ?: return
        viewModelScope.launch {
            try {
                backend.deleteTrack(track.id)
                // 204 carries no summary: the same frame the room gets says it, so reuse the song's with a count down.
                onFrame(
                    JamFrame.TrackDeleted(
                        channelId,
                        state.song.copy(trackCount = (state.song.trackCount - 1).coerceAtLeast(0)),
                        track.id,
                    ),
                )
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                notice(JamNotice.DeleteFailed)
            }
        }
    }

    fun deleteSong() {
        viewModelScope.launch {
            try {
                backend.deleteSong(songId)
                stopEverything()
                _ui.update { it.copy(phase = JamSongUi.Phase.Gone) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                notice(JamNotice.DeleteFailed)
            }
        }
    }

    // --- housekeeping ---

    private fun notice(value: JamNotice) = _ui.update { it.copy(notice = value) }

    fun dismissNotice() = _ui.update { it.copy(notice = null) }

    private fun stopEverything() {
        player.pause()
        video.pause()
        _ui.update { it.copy(playing = false) }
        focus.release()
    }

    /**
     * Frees everything that holds a codec, a file or the speaker. Called when
     * the song screen goes away (the wall stays; the view model outlives the
     * screen inside its navigation entry, so this cannot wait for [onCleared]).
     * Safe to call twice.
     */
    fun releaseMedia() {
        // Nothing may start again on a released engine: stop listening for frames and finish what was in flight.
        viewModelScope.coroutineContext[kotlinx.coroutines.Job]?.children?.forEach { it.cancel() }
        focus.release()
        player.release()
        video.release()
        loader.close()
    }

    override fun onCleared() = releaseMedia()

    companion object {
        /** The video is checked against the audio clock this often. */
        const val VIDEO_SYNC_NANOS = 250_000_000L

        fun factory(
            session: SessionStore,
            context: Context,
            callActive: StateFlow<Boolean>,
            songId: String,
            channelId: String,
        ) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = JamSongViewModel(
                backend = SessionJamBackend(session),
                context = context,
                http = session.http,
                songId = songId,
                channelId = channelId,
                callActive = callActive,
            ) as T
        }
    }
}
