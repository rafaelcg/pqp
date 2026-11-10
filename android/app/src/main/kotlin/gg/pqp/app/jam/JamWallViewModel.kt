package gg.pqp.app.jam

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * What a tile knows about a song beyond its summary. The list carries no media,
 * no peaks and no names (`docs/JAM.md`: the summary is counts), so a tile that
 * wants a waveform, a poster or "rafa, duda, leo" reads the song's detail once,
 * lazily, as it scrolls into view.
 */
data class JamPreview(
    /** The bump this was read at: a newer `updatedAt` on the summary says it is stale. */
    val readAtMs: Long,
    /** The mix's loudness across its length, for a coloured tile's waveform. */
    val envelope: List<Double>,
    /** People with a track, in the order they joined. */
    val contributors: List<String>,
    /** The first in-mix track with a video: its poster frame is the tile's picture. */
    val posterTrackId: String?,
    val posterUrl: String?,
    val hasVideo: Boolean,
) {
    companion object {
        const val ENVELOPE_BARS = 48

        fun of(detail: JamSongDetailResponse): JamPreview {
            val tracks = detail.tracks
            val seen = HashSet<String>()
            val contributors = tracks.mapNotNull { track ->
                val name = track.authorName
                if (name != null && seen.add(track.authorId)) name else null
            }
            val withVideo = tracks.filter { it.hasVideo && it.inMix }
            val poster = withVideo.firstOrNull()
            return JamPreview(
                readAtMs = detail.song.updatedAtMs,
                envelope = JamPeaks.mixEnvelope(tracks, ENVELOPE_BARS),
                contributors = contributors,
                posterTrackId = poster?.id,
                posterUrl = poster?.videoUrl,
                hasVideo = withVideo.isNotEmpty(),
            )
        }
    }
}

data class JamWallUiState(
    val wall: JamWallState = JamWallState(),
    val filter: JamWallFilter = JamWallFilter.All,
    val config: JamConfig = JamConfig.Off,
    val phase: Phase = Phase.Loading,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    /** The last page request failed: the wall offers a retry at its end. */
    val loadMoreFailed: Boolean = false,
    val previews: Map<String, JamPreview> = emptyMap(),
) {
    enum class Phase { Loading, Ready, Failed }

    /** The songs the filter lets through, in the server's order. */
    val visible: List<JamSongSummary> get() = wall.songs.filter(filter::matches)

    /** Nothing in the channel at all, as opposed to nothing under this filter. */
    val emptyWall: Boolean get() = phase == Phase.Ready && wall.isEmpty

    fun preview(song: JamSongSummary): JamPreview? = previews[song.id]?.takeIf { it.readAtMs >= song.updatedAtMs }

    /** A stale preview beats a flash of nothing. */
    fun anyPreview(song: JamSongSummary): JamPreview? = previews[song.id]
}

/**
 * One jam channel's wall: the pages, the filter, the live frames and the lazily
 * read previews. The rules for each live in `JamWallRules`; this object fetches,
 * holds and hands frames to them.
 */
class JamWallViewModel(
    private val backend: JamBackend,
    private val serverId: String,
    private val channelId: String,
    private val seen: (ms: Long) -> Unit = {},
) : ViewModel() {
    private val _state = MutableStateFlow(JamWallUiState())
    val state: StateFlow<JamWallUiState> = _state.asStateFlow()

    /** Bumped by every page-one read; an answer that a newer read has overtaken is dropped. */
    private var generation = 0

    /**
     * Live frames that arrive while a page-one read is in flight. The read's
     * answer was produced before them, so replacing the wall with it would lose
     * them; they are applied on top of it instead.
     */
    private val buffered = ArrayList<JamFrame>()
    private var reading = false

    private var started = false
    private var readJob: Job? = null

    // Previews: queued, and at most [PREVIEW_WORKERS] in flight, so a fast scroll
    // over twenty tiles is three requests, not twenty.
    private val queue = ArrayDeque<String>()
    private val inFlight = HashSet<String>()

    /** Once per appearance of the screen; safe to call again (it joins again and refreshes). */
    fun start() {
        backend.join(channelId)
        if (started) {
            refresh()
            return
        }
        started = true
        viewModelScope.launch { backend.frames.collect { apply(it) } }
        // A reconnect missed frames: read the wall again once the socket is back.
        viewModelScope.launch {
            var wasDown = false
            backend.connection.collect { connection ->
                if (connection == RealtimeState.Ready) {
                    if (wasDown) refresh()
                    wasDown = false
                } else {
                    wasDown = true
                }
            }
        }
        viewModelScope.launch { _state.update { it.copy(config = backend.config(serverId)) } }
        load()
    }

    fun stop() {
        backend.leave(channelId)
    }

    override fun onCleared() {
        backend.leave(channelId)
    }

    fun setFilter(filter: JamWallFilter) = _state.update { it.copy(filter = filter) }

    fun clearFresh(id: String) = _state.update { it.copy(wall = it.wall.clearFresh(id)) }

    // --- reads ---

    fun load() {
        readJob?.cancel()
        generation += 1
        val request = generation
        _state.update {
            if (it.wall.isEmpty) it.copy(phase = JamWallUiState.Phase.Loading) else it.copy(refreshing = true)
        }
        reading = true
        buffered.clear()
        readJob = viewModelScope.launch {
            try {
                val page = backend.songs(channelId)
                if (request != generation) return@launch
                _state.update { current ->
                    var wall = current.wall.replace(page)
                    // What happened while the read was out, on top of what it says.
                    buffered.forEach { wall = wall.apply(it, channelId) }
                    current.copy(wall = wall, phase = JamWallUiState.Phase.Ready, refreshing = false, loadMoreFailed = false)
                }
                markSeen()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (request != generation) return@launch
                // A wall already on screen keeps it; only a first read fails loud.
                _state.update {
                    it.copy(
                        refreshing = false,
                        phase = if (it.wall.isEmpty) JamWallUiState.Phase.Failed else it.phase,
                    )
                }
            } finally {
                if (request == generation) {
                    reading = false
                    buffered.clear()
                }
            }
        }
    }

    /** Pull to refresh. A failed refresh keeps the wall. */
    fun refresh() {
        load()
        viewModelScope.launch { _state.update { it.copy(config = backend.config(serverId)) } }
    }

    /**
     * The next page. An answer that a refresh has overtaken (the cursor it
     * followed is no longer the wall's) is dropped, and a failure leaves a retry
     * in place of the end of the wall.
     */
    fun loadMore() {
        val current = _state.value
        val cursor = current.wall.nextCursor ?: return
        if (current.loadingMore) return
        val request = generation
        _state.update { it.copy(loadingMore = true, loadMoreFailed = false) }
        viewModelScope.launch {
            try {
                val page = backend.songs(channelId, cursor = cursor)
                if (request != generation || _state.value.wall.nextCursor != cursor) {
                    _state.update { it.copy(loadingMore = false) }
                    return@launch
                }
                _state.update { it.copy(wall = it.wall.append(page), loadingMore = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(loadingMore = false, loadMoreFailed = request == generation) }
            }
        }
    }

    /** The last tile that shows came on screen: the next page is wanted. (The caller knows which is last; no rescan here.) */
    fun lastTileShown() = loadMore()

    private fun markSeen() {
        val newest = _state.value.wall.songs.firstOrNull()?.updatedAtMs ?: return
        seen(newest)
    }

    // --- live frames ---

    internal fun apply(frame: JamFrame) {
        if (reading) buffered += frame
        val before = _state.value.wall
        val after = before.apply(frame, channelId)
        if (after != before) {
            _state.update { it.copy(wall = after) }
            // Looking at the wall is reading it.
            markSeen()
        }
        if (frame is JamFrame.SongDeleted) _state.update { it.copy(previews = it.previews - frame.songId) }
    }

    // --- previews ---

    /** Ask for a song's preview. Queued, bounded, and dropped again by [cancelPreview]. */
    fun requestPreview(song: JamSongSummary) {
        if (song.trackCount == 0 || _state.value.preview(song) != null) return
        if (song.id in inFlight || song.id in queue) return
        queue.addLast(song.id)
        pump()
    }

    /** The tile left the screen before its turn: it does not need the read. */
    fun cancelPreview(songId: String) {
        queue.remove(songId)
    }

    private fun pump() {
        while (inFlight.size < PREVIEW_WORKERS && queue.isNotEmpty()) {
            val id = queue.removeFirst()
            inFlight += id
            viewModelScope.launch {
                try {
                    val detail = backend.song(id)
                    _state.update { it.copy(previews = boundedPreviews(it.previews + (id to JamPreview.of(detail)))) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // A tile without a preview is a tile with a coloured ground; the next appearance asks again.
                } finally {
                    inFlight -= id
                    pump()
                }
            }
        }
    }

    companion object {
        const val PREVIEW_WORKERS = 3

        /** Previews kept: the oldest read go first, so a long scroll does not hold every song it passed. */
        const val PREVIEW_CACHE = 120

        /** [previews] (insertion order) cut to the newest [PREVIEW_CACHE]. A tile that scrolls back asks again. */
        internal fun boundedPreviews(previews: Map<String, JamPreview>): Map<String, JamPreview> =
            if (previews.size <= PREVIEW_CACHE) previews else previews.entries.drop(previews.size - PREVIEW_CACHE).associate { it.toPair() }

        fun factory(session: SessionStore, seen: JamSeenStore, serverId: String, channelId: String) =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = JamWallViewModel(
                    backend = SessionJamBackend(session),
                    serverId = serverId,
                    channelId = channelId,
                    seen = { ms -> seen.markSeen(channelId, ms) },
                ) as T
            }
    }
}

/**
 * The channel list's side of it: whether jam is on for this server, and per
 * channel the song count and whether something is new. With the flag off
 * nothing is drawn, and a server with no jam channel never asks.
 */
class JamListModel(
    private val backend: JamBackend,
    private val seen: (channelId: String) -> Long?,
) {
    data class Rows(val config: JamConfig = JamConfig.Off, val rows: Map<String, JamRowSummary> = emptyMap())

    /**
     * One config read and, when it is on, one first page per jam channel (a
     * server has a handful). A channel whose read failed keeps what its row said.
     */
    suspend fun read(serverId: String, jamChannelIds: List<String>, previous: Rows = Rows()): Rows {
        if (jamChannelIds.isEmpty()) return Rows()
        // A config read that fails (the production client already answers "off" for that, but this seam may throw)
        // keeps what the row said: a transient outage must not make the row vanish.
        val config = try {
            backend.config(serverId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return previous
        }
        if (!config.enabled) return Rows(config)
        val viewerId = backend.viewerId
        val rows = coroutineScope {
            jamChannelIds.map { id ->
                async {
                    id to try {
                        JamRowSummary.of(backend.songs(id, limit = JamLimits.PAGE_MAX), viewerId, seen(id))
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        previous.rows[id]
                    }
                }
            }.awaitAll()
        }.mapNotNull { (id, row) -> row?.let { id to it } }.toMap()
        return Rows(config, rows)
    }
}
